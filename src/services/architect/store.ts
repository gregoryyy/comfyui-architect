// Architect's own database, `architect.db` (spec §15.1, §15.2; TODO 2.2).
//
// Separate from upstream's `generations.db`, which Architect never modifies (AGENTS, fork
// discipline). Opened the way upstream opens its database (better-sqlite3, WAL, foreign
// keys), next to upstream's data and never inside the ComfyUI install (upstream #872).
//
// Two rules hold for every repository method below:
// - A write validates its record with the schema before it touches the database, so an
//   invalid record never reaches disk.
// - A read of a payload goes through `parseStored`, so a payload that was edited by hand or
//   written by a newer build throws `StoredRecordError` instead of being returned as though
//   this build understood it.
//
// Payloads are stored as canonical JSON (sorted keys), so "the same record" is a string
// comparison and an idempotent rewrite can be told apart from a conflicting one.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson } from "./hash.js";
import { MIGRATIONS, SCHEMA_MIGRATIONS_SQL } from "./migrations.js";
import {
  EnvironmentSnapshot,
  Plan,
  PlanCandidate,
  Recipe,
  type StoredKind,
  StoredRecordError,
  TaskSpec,
  type WorkflowKind,
  parseStored,
} from "./schemas.js";

/** The database file inside the Architect data directory. */
export const ARCHITECT_DB_FILE = "architect.db";

/**
 * The Architect data directory (spec §15.1, ARCH 2026-11-15): `ARCHITECT_DATA_DIR` when
 * set, otherwise `architect/` under upstream's data directory, so both stay together and
 * out of the ComfyUI install (upstream #872).
 */
export function architectDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ARCHITECT_DATA_DIR?.trim();
  if (explicit) {
    // A relative path resolves against each process's working directory, so the stdio
    // route and the panel's tool server would open different databases (SEC T9).
    if (!isAbsolute(explicit)) throw new Error(`ARCHITECT_DATA_DIR must be an absolute path, got "${explicit}"`);
    return explicit;
  }
  const base = env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
  return join(base, "architect");
}

/** A write the store refuses because it contradicts what is already stored. */
export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

/** A database whose applied migrations are newer than this build knows. */
export class StoreVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreVersionError";
  }
}

const Timestamp = z.string().datetime({ offset: true });

/** Where recipes come from and how far they are trusted (spec §8.2). */
export const CatalogSource = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["bundled", "local", "fixture"]),
    /** The directory the source's recipe files are read from. */
    root: z.string().min(1),
    trust: z.enum(["maintainer", "user", "test"]),
    /** Absent until the source has been read once. */
    lastRefreshAt: Timestamp.optional(),
  })
  .strict();
export type CatalogSource = z.infer<typeof CatalogSource>;

/** Options for `ArchitectStore.open`. */
export interface ArchitectStoreOptions {
  /** The clock for times the store itself records (migrations, recipe loads); injected for tests. */
  now?: () => Date;
}

// Row shapes. better-sqlite3 returns `unknown`; parsing the row keeps a schema drift from
// turning into a wrong type further on.
const PayloadRow = z.object({ payload: z.string() });
const RevisionPayloadRow = z.object({ revision: z.number().int(), payload: z.string() });
const IdPayloadRow = z.object({ id: z.string(), payload: z.string() });
const RecipeRow = z.object({ id: z.string(), revision: z.number().int(), payload: z.string() });
const TaskHeadRow = z.object({ latest_revision: z.number().int() });
const RecipeHashRow = z.object({ content_hash: z.string() });
const MaxVersionRow = z.object({ version: z.number().int().nullable() });
const PlanTargetRow = z.object({
  task_id: z.string(),
  task_revision: z.number().int(),
  environment_id: z.string(),
  created_at: z.string(),
});
const CandidatePlanRow = z.object({ plan_id: z.string() });
const CatalogSourceRow = z.object({
  id: z.string(),
  kind: z.string(),
  root: z.string(),
  trust: z.string(),
  last_refresh_at: z.string().nullable(),
});
const RecordIdentity = z.object({ id: z.string(), revision: z.number().optional() });
const ContentHash = z.string().min(1);

function parseRow<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  return value === undefined ? undefined : schema.parse(value);
}

type Stored<K extends StoredKind> = ReturnType<typeof parseStored<K>>;

/**
 * Parse a payload column back into its record. Besides `parseStored`, the record's own id
 * and revision must match the row it sits in: a payload copied into another row is as
 * untrustworthy as an edited one.
 */
function readStored<K extends StoredKind>(kind: K, payload: string, row: { id: string; revision?: number }): Stored<K> {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (err) {
    throw new StoredRecordError(kind, `payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = parseStored(kind, raw);
  const identity = RecordIdentity.parse(record);
  if (identity.id !== row.id || (row.revision !== undefined && identity.revision !== row.revision)) {
    throw new StoredRecordError(kind, `payload of row ${row.id} carries the identity of ${identity.id}`);
  }
  return record;
}

/** Time columns hold UTC ISO strings, so ordering by them is ordering by time. */
function utc(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

/**
 * Apply the migrations this database lacks, each in its own IMMEDIATE transaction. The
 * check for "already applied" runs inside that transaction, so two processes opening the
 * same fresh database don't both run version 1.
 */
function applyMigrations(db: Database.Database, path: string, now: () => Date): void {
  db.exec(SCHEMA_MIGRATIONS_SQL);
  const known = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  const newest = parseRow(MaxVersionRow, db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get());
  if (newest && newest.version !== null && newest.version > known) {
    // A newer build changed the schema; writing to it with this build's assumptions could
    // corrupt it, the same reason `parseStored` refuses a newer payload.
    throw new StoreVersionError(`${path} is at schema version ${newest.version}, newer than this build (${known})`);
  }
  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of MIGRATIONS) {
    db.transaction(() => {
      if (isApplied.get(migration.version) !== undefined) return;
      db.exec(migration.sql);
      record.run(migration.version, migration.name, now().toISOString());
    }).immediate();
  }
}

function prepareStatements(db: Database.Database) {
  return {
    taskHead: db.prepare("SELECT latest_revision FROM tasks WHERE id = ?"),
    insertTask: db.prepare("INSERT INTO tasks (id, latest_revision, created_at, updated_at) VALUES (?, ?, ?, ?)"),
    advanceTask: db.prepare("UPDATE tasks SET latest_revision = ?, updated_at = ? WHERE id = ?"),
    insertTaskRevision: db.prepare(
      "INSERT INTO task_revisions (task_id, revision, payload, created_at) VALUES (?, ?, ?, ?)",
    ),
    taskRevision: db.prepare("SELECT revision, payload FROM task_revisions WHERE task_id = ? AND revision = ?"),
    latestTaskRevision: db.prepare(
      `SELECT r.revision, r.payload FROM task_revisions r
       JOIN tasks t ON t.id = r.task_id AND t.latest_revision = r.revision
       WHERE t.id = ?`,
    ),

    environment: db.prepare("SELECT id, payload FROM environments WHERE id = ?"),
    insertEnvironment: db.prepare(
      "INSERT INTO environments (id, base_url, captured_at, node_schema_digest, payload) VALUES (?, ?, ?, ?, ?)",
    ),
    latestSnapshot: db.prepare(
      "SELECT id, payload FROM environments WHERE base_url = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1",
    ),

    upsertCatalogSource: db.prepare(
      `INSERT INTO catalog_sources (id, kind, root, trust, last_refresh_at)
       VALUES (@id, @kind, @root, @trust, @lastRefreshAt)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         root = excluded.root,
         trust = excluded.trust,
         last_refresh_at = COALESCE(excluded.last_refresh_at, catalog_sources.last_refresh_at)`,
    ),
    listCatalogSources: db.prepare("SELECT id, kind, root, trust, last_refresh_at FROM catalog_sources ORDER BY id"),

    recipeHash: db.prepare("SELECT content_hash FROM recipes WHERE id = ? AND revision = ?"),
    insertRecipe: db.prepare(
      `INSERT INTO recipes (id, revision, source_id, content_hash, kind, certification, payload, loaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    recipe: db.prepare("SELECT id, revision, payload FROM recipes WHERE id = ? AND revision = ?"),
    latestRecipe: db.prepare("SELECT id, revision, payload FROM recipes WHERE id = ? ORDER BY revision DESC LIMIT 1"),
    listLatestRecipes: db.prepare(
      `SELECT r.id, r.revision, r.payload FROM recipes r
       JOIN (SELECT id, MAX(revision) AS revision FROM recipes GROUP BY id) m
         ON m.id = r.id AND m.revision = r.revision
       WHERE @kind IS NULL OR r.kind = @kind
       ORDER BY r.id`,
    ),

    planTarget: db.prepare("SELECT task_id, task_revision, environment_id, created_at FROM plans WHERE id = ?"),
    insertPlan: db.prepare(
      `INSERT INTO plans (id, task_id, task_revision, environment_id, state, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updatePlan: db.prepare("UPDATE plans SET state = ?, updated_at = ?, payload = ? WHERE id = ?"),
    plan: db.prepare("SELECT id, payload FROM plans WHERE id = ?"),
    plansForTask: db.prepare("SELECT id, payload FROM plans WHERE task_id = ? ORDER BY created_at, id"),

    candidatePlan: db.prepare("SELECT plan_id FROM plan_candidates WHERE id = ?"),
    upsertCandidate: db.prepare(
      `INSERT INTO plan_candidates (id, plan_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload`,
    ),
    candidate: db.prepare("SELECT id, payload FROM plan_candidates WHERE id = ?"),
    candidatesForPlan: db.prepare("SELECT id, payload FROM plan_candidates WHERE plan_id = ? ORDER BY created_at, id"),
  };
}

/**
 * The `architect.db` store: one better-sqlite3 connection and the repositories on it.
 * Synchronous, as better-sqlite3 is; every multi-step write runs in a transaction.
 */
/** Re-exported for callers that already import it from here. */
export { canonicalJson };

export class ArchitectStore {
  private readonly stmts: ReturnType<typeof prepareStatements>;

  private constructor(
    private readonly db: Database.Database,
    /** The database file this store opened. */
    readonly path: string,
    private readonly now: () => Date,
  ) {
    this.stmts = prepareStatements(db);
  }

  /** Open (creating if needed) `<dir>/architect.db` and apply pending migrations. */
  static open(dir: string = architectDataDir(), options: ArchitectStoreOptions = {}): ArchitectStore {
    const now = options.now ?? (() => new Date());
    mkdirSync(dir, { recursive: true });
    const path = join(dir, ARCHITECT_DB_FILE);
    const db = new BetterSqlite3(path);
    try {
      // busy_timeout first: switching to WAL and migrating both take locks another
      // connection (a second MCP process, the panel's tool server) may briefly hold.
      db.pragma("busy_timeout = 5000");
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      applyMigrations(db, path, now);
      return new ArchitectStore(db, path, now);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Close the connection. The store is unusable afterwards. */
  close(): void {
    this.db.close();
  }

  /** Run `fn` in one transaction; nested calls become savepoints. `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // -------------------------------------------------------------------------------------
  // Tasks

  /**
   * Store a task revision. Revision 1 creates the task; revision n+1 advances it. Writing
   * an existing revision again is a no-op when the content is the same and refused when it
   * differs: a stored revision is what plans were made for, so it never changes.
   */
  putTaskRevision(input: z.input<typeof TaskSpec>): TaskSpec {
    const task = TaskSpec.parse(input);
    const payload = canonicalJson(task);
    return this.transaction(() => {
      const existing = parseRow(RevisionPayloadRow, this.stmts.taskRevision.get(task.id, task.revision));
      if (existing) {
        const stored = readStored("task", existing.payload, { id: task.id, revision: existing.revision });
        if (canonicalJson(stored) === payload) return task;
        throw new StoreConflictError(
          `task ${task.id} revision ${task.revision} is already stored with different content; a change needs a new revision`,
        );
      }
      const head = parseRow(TaskHeadRow, this.stmts.taskHead.get(task.id));
      const expected = (head?.latest_revision ?? 0) + 1;
      if (task.revision !== expected) {
        throw new StoreConflictError(`task ${task.id}: the next revision is ${expected}, not ${task.revision}`);
      }
      if (head) this.stmts.advanceTask.run(task.revision, utc(task.updatedAt), task.id);
      else this.stmts.insertTask.run(task.id, task.revision, utc(task.createdAt), utc(task.updatedAt));
      // A revision is made when the task is updated, so its row carries `updatedAt`.
      this.stmts.insertTaskRevision.run(task.id, task.revision, payload, utc(task.updatedAt));
      return task;
    });
  }

  /** A task revision, the latest by default; undefined when the task or revision isn't stored. */
  getTask(id: string, revision?: number): TaskSpec | undefined {
    const row = parseRow(
      RevisionPayloadRow,
      revision === undefined ? this.stmts.latestTaskRevision.get(id) : this.stmts.taskRevision.get(id, revision),
    );
    return row && readStored("task", row.payload, { id, revision: row.revision });
  }

  // -------------------------------------------------------------------------------------
  // Environments

  /**
   * Store an environment snapshot. A snapshot records one moment, so it is immutable:
   * the same snapshot again is a no-op, a different one under the same id is refused.
   */
  putSnapshot(input: z.input<typeof EnvironmentSnapshot>): EnvironmentSnapshot {
    const snapshot = EnvironmentSnapshot.parse(input);
    const payload = canonicalJson(snapshot);
    return this.transaction(() => {
      const existing = parseRow(IdPayloadRow, this.stmts.environment.get(snapshot.id));
      if (existing) {
        const stored = readStored("environment", existing.payload, { id: existing.id });
        if (canonicalJson(stored) === payload) return snapshot;
        throw new StoreConflictError(`environment ${snapshot.id} is already stored with different content`);
      }
      this.stmts.insertEnvironment.run(
        snapshot.id,
        snapshot.target.baseUrl,
        utc(snapshot.capturedAt),
        snapshot.nodeSchemaDigest ?? null,
        payload,
      );
      return snapshot;
    });
  }

  /** An environment snapshot by id; undefined when not stored. */
  getSnapshot(id: string): EnvironmentSnapshot | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.environment.get(id));
    return row && readStored("environment", row.payload, { id: row.id });
  }

  /** The most recently captured snapshot of a target; undefined when none is stored. */
  latestSnapshot(baseUrl: string): EnvironmentSnapshot | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.latestSnapshot.get(baseUrl));
    return row && readStored("environment", row.payload, { id: row.id });
  }

  // -------------------------------------------------------------------------------------
  // Catalog sources and recipes

  /**
   * Register a catalog source or update its kind, root and trust. An omitted
   * `lastRefreshAt` keeps the stored one: re-registering a source isn't a refresh.
   */
  upsertCatalogSource(input: z.input<typeof CatalogSource>): CatalogSource {
    const source = CatalogSource.parse(input);
    this.stmts.upsertCatalogSource.run({
      id: source.id,
      kind: source.kind,
      root: source.root,
      trust: source.trust,
      lastRefreshAt: source.lastRefreshAt === undefined ? null : utc(source.lastRefreshAt),
    });
    return source;
  }

  /** Every registered catalog source, by id. */
  listCatalogSources(): CatalogSource[] {
    return this.stmts.listCatalogSources.all().map((value) => {
      const row = CatalogSourceRow.parse(value);
      return CatalogSource.parse({
        id: row.id,
        kind: row.kind,
        root: row.root,
        trust: row.trust,
        ...(row.last_refresh_at === null ? {} : { lastRefreshAt: row.last_refresh_at }),
      });
    });
  }

  /**
   * Store a recipe revision loaded from `sourceId`. Loading the same file again (same id,
   * revision and content hash) is a no-op. The same id and revision with another hash is
   * refused: plans and run records name a recipe by id and revision, so a revision must
   * keep meaning one graph.
   */
  putRecipe(input: z.input<typeof Recipe>, sourceId: string, contentHash: string): Recipe {
    const recipe = Recipe.parse(input);
    const hash = ContentHash.parse(contentHash);
    const payload = canonicalJson(recipe);
    return this.transaction(() => {
      const existing = parseRow(RecipeHashRow, this.stmts.recipeHash.get(recipe.id, recipe.revision));
      if (existing) {
        if (existing.content_hash === hash) return recipe;
        throw new StoreConflictError(
          `recipe ${recipe.id} revision ${recipe.revision} is already stored with another content hash; a changed recipe needs a new revision`,
        );
      }
      this.stmts.insertRecipe.run(
        recipe.id,
        recipe.revision,
        sourceId,
        hash,
        recipe.kind,
        recipe.certification,
        payload,
        this.now().toISOString(),
      );
      return recipe;
    });
  }

  /** A recipe revision, the highest by default; undefined when not stored. */
  getRecipe(id: string, revision?: number): Recipe | undefined {
    const row = parseRow(
      RecipeRow,
      revision === undefined ? this.stmts.latestRecipe.get(id) : this.stmts.recipe.get(id, revision),
    );
    return row && readStored("recipe", row.payload, { id: row.id, revision: row.revision });
  }

  /** The highest revision of every stored recipe, by id; filtered by kind when given. */
  listRecipes(filter: { kind?: WorkflowKind } = {}): Recipe[] {
    return this.stmts.listLatestRecipes.all({ kind: filter.kind ?? null }).map((value) => {
      const row = RecipeRow.parse(value);
      return readStored("recipe", row.payload, { id: row.id, revision: row.revision });
    });
  }

  // -------------------------------------------------------------------------------------
  // Plans and candidates

  /**
   * Insert a plan or update its state and payload. What a plan was made for (task
   * revision, environment, creation time) is refused as an update: a plan for another
   * target is another plan.
   */
  putPlan(input: z.input<typeof Plan>): Plan {
    const plan = Plan.parse(input);
    const payload = canonicalJson(plan);
    return this.transaction(() => {
      const target = parseRow(PlanTargetRow, this.stmts.planTarget.get(plan.id));
      if (!target) {
        this.stmts.insertPlan.run(
          plan.id,
          plan.taskId,
          plan.taskRevision,
          plan.environmentId,
          plan.state,
          utc(plan.createdAt),
          utc(plan.updatedAt),
          payload,
        );
        return plan;
      }
      if (
        target.task_id !== plan.taskId ||
        target.task_revision !== plan.taskRevision ||
        target.environment_id !== plan.environmentId ||
        target.created_at !== utc(plan.createdAt)
      ) {
        throw new StoreConflictError(
          `plan ${plan.id} was made for task ${target.task_id} revision ${target.task_revision} in environment ${target.environment_id}; its target can't change`,
        );
      }
      this.stmts.updatePlan.run(plan.state, utc(plan.updatedAt), payload, plan.id);
      return plan;
    });
  }

  /** A plan by id; undefined when not stored. */
  getPlan(id: string): Plan | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.plan.get(id));
    return row && readStored("plan", row.payload, { id: row.id });
  }

  /** Every plan of a task, oldest first. */
  listPlans(filter: { taskId: string }): Plan[] {
    return this.stmts.plansForTask.all(filter.taskId).map((value) => {
      const row = IdPayloadRow.parse(value);
      return readStored("plan", row.payload, { id: row.id });
    });
  }

  /** Insert a candidate or update its status and payload; moving it to another plan is refused. */
  putCandidate(input: z.input<typeof PlanCandidate>): PlanCandidate {
    const candidate = PlanCandidate.parse(input);
    const payload = canonicalJson(candidate);
    return this.transaction(() => {
      const existing = parseRow(CandidatePlanRow, this.stmts.candidatePlan.get(candidate.id));
      if (existing && existing.plan_id !== candidate.planId) {
        throw new StoreConflictError(`candidate ${candidate.id} belongs to plan ${existing.plan_id}, not ${candidate.planId}`);
      }
      this.stmts.upsertCandidate.run(candidate.id, candidate.planId, candidate.status, utc(candidate.createdAt), payload);
      return candidate;
    });
  }

  /** A candidate by id; undefined when not stored. */
  getCandidate(id: string): PlanCandidate | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.candidate.get(id));
    return row && readStored("candidate", row.payload, { id: row.id });
  }

  /** Every candidate of a plan, oldest first. */
  listCandidates(planId: string): PlanCandidate[] {
    return this.stmts.candidatesForPlan.all(planId).map((value) => {
      const row = IdPayloadRow.parse(value);
      return readStored("candidate", row.payload, { id: row.id });
    });
  }
}
