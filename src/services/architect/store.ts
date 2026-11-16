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
import { ARCHITECT_SCHEMA_VERSION } from "../../fork-identity.js";
import { canonicalJson } from "./hash.js";
import { MIGRATIONS, SCHEMA_MIGRATIONS_SQL } from "./migrations.js";
import {
  Acceptance,
  type AcquireModelsEffect,
  AcquisitionRecord,
  AcquisitionState,
  ActionPlan,
  ApprovalGrant,
  ApprovalRequest,
  type ApprovalRequestState,
  ArchitectErrorCode,
  EnvironmentSnapshot,
  EvaluationRecord,
  Plan,
  PlanCandidate,
  Recipe,
  ResourceLease,
  RunError,
  RunEvent,
  RunEventKind,
  RunOutput,
  RunPrincipal,
  RunRecord,
  RunState,
  RunTimings,
  type StoredKind,
  StoredRecordError,
  TaskSpec,
  type WorkflowKind,
  canAcquisitionTransition,
  canTransition,
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

/** A run transition the state machine of spec §15.3 doesn't allow: a bug in the caller. A race is a StoreConflictError. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`a run can't move from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** An acquisition transition the table in schemas.ts doesn't allow: a bug in the caller. */
export class IllegalAcquisitionTransitionError extends Error {
  constructor(
    readonly from: AcquisitionState,
    readonly to: AcquisitionState,
  ) {
    super(`an acquisition can't move from ${from} to ${to}`);
    this.name = "IllegalAcquisitionTransitionError";
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
const EventRow = z.object({ run_id: z.string(), seq: z.number().int(), payload: z.string() });
const AcquisitionRow = z.object({ id: z.string(), run_id: z.string(), payload: z.string() });
const MaxSeqRow = z.object({ seq: z.number().int().nullable() });
const LeaseRow = z.object({
  pool: z.string(),
  owner_id: z.string(),
  run_id: z.string().nullable(),
  acquired_at: z.string(),
  heartbeat_at: z.string(),
  expires_at: z.string(),
});
const LeaseTtl = z.number().int().positive();

/**
 * What a transition may change on a run besides its state. Identity, target, key and grant
 * are fixed at creation; `timings` merges into the stored timings, `outputs` replaces them,
 * and `error: null` clears an error (a run reconciled out of OUTCOME_UNKNOWN). Its fields
 * carry no defaults, so a field the caller left out stays as stored.
 */
export const RunPatch = z
  .object({
    promptId: z.string().uuid().optional(),
    outputs: z.array(RunOutput).optional(),
    timings: RunTimings.optional(),
    acceptance: Acceptance.optional(),
    error: RunError.nullable().optional(),
  })
  .strict();
export type RunPatch = z.input<typeof RunPatch>;

/**
 * What a transition may change on an acquisition besides its state. Source, destination and
 * identity are fixed at creation. `null` clears a field: the job id of a download lost with
 * the process (downloading → planned), the staged path of a staged file that vanished
 * (verifying → downloading), and the error when there is none any more.
 */
export const AcquisitionPatch = z
  .object({
    jobId: z.string().min(1).nullable().optional(),
    stagedPath: z.string().min(1).nullable().optional(),
    placedPath: z.string().min(1).optional(),
    observedSha256: z.string().nullable().optional(),
    observedBytes: z.number().int().nonnegative().nullable().optional(),
    error: z.object({ code: ArchitectErrorCode, message: z.string().min(1) }).strict().nullable().optional(),
  })
  .strict();
export type AcquisitionPatch = z.input<typeof AcquisitionPatch>;

/** The outcome of `acquireLease`: the pool's lease now held, or who holds it. */
export type LeaseAcquisition =
  | {
      acquired: true;
      lease: ResourceLease;
      /** The expired lease of another holder this acquisition replaced, so the takeover is visible. */
      tookOverFrom?: ResourceLease;
    }
  | { acquired: false; holder: ResourceLease };

function leaseFromRow(value: unknown): ResourceLease | undefined {
  const row = parseRow(LeaseRow, value);
  return (
    row &&
    ResourceLease.parse({
      pool: row.pool,
      ownerId: row.owner_id,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    })
  );
}

/** Parse a run event's payload; besides `parseStored`, its run and seq must match its row. */
function readEvent(row: z.infer<typeof EventRow>): RunEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch (err) {
    throw new StoredRecordError("runEvent", `payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const event = parseStored("runEvent", raw);
  if (event.runId !== row.run_id || event.seq !== row.seq) {
    throw new StoredRecordError("runEvent", `payload of row ${row.run_id}#${row.seq} carries ${event.runId}#${event.seq}`);
  }
  return event;
}
const ContentHash = z.string().min(1);

/** Parse an acquisition's payload; besides its id, its run must match its row. */
function readAcquisition(value: unknown): AcquisitionRecord {
  const row = AcquisitionRow.parse(value);
  const record = readStored("acquisition", row.payload, { id: row.id });
  if (record.runId !== row.run_id) {
    throw new StoredRecordError("acquisition", `payload of row ${row.id} names run ${record.runId}, the row ${row.run_id}`);
  }
  return record;
}

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

    actionPlan: db.prepare("SELECT id, payload FROM action_plans WHERE id = ?"),
    insertActionPlan: db.prepare(
      `INSERT INTO action_plans
         (id, plan_id, task_id, task_revision, candidate_id, environment_id, base_url, hash, created_at, expires_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),

    approvalRequest: db.prepare("SELECT id, payload FROM approval_requests WHERE id = ?"),
    pendingRequests: db.prepare("SELECT id, payload FROM approval_requests WHERE state = 'pending' AND expires_at > ? ORDER BY created_at, id"),
    requestsForActionPlan: db.prepare("SELECT id, payload FROM approval_requests WHERE action_plan_id = ? ORDER BY created_at DESC, id DESC"),
    insertApprovalRequest: db.prepare(
      `INSERT INTO approval_requests (id, action_plan_id, action_plan_hash, state, created_at, expires_at, resolved_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    resolveApprovalRequest: db.prepare(
      "UPDATE approval_requests SET state = ?, resolved_at = ?, payload = ? WHERE id = ? AND state = 'pending'",
    ),

    grant: db.prepare("SELECT id, payload FROM approval_grants WHERE id = ?"),
    insertGrant: db.prepare(
      `INSERT INTO approval_grants
         (id, approval_request_id, action_plan_id, action_plan_hash, base_url, channel, issued_at, expires_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    usableGrant: db.prepare(
      `SELECT id, payload FROM approval_grants
       WHERE action_plan_id = ? AND action_plan_hash = ? AND base_url = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
    ),
    consumeGrant: db.prepare(
      "UPDATE approval_grants SET consumed_at = ?, consumed_by_run_id = ?, payload = ? WHERE id = ? AND consumed_at IS NULL",
    ),

    run: db.prepare("SELECT id, payload FROM runs WHERE id = ?"),
    runByIdempotencyKey: db.prepare("SELECT id, payload FROM runs WHERE idempotency_key = ?"),
    // The state filter is a JSON array bound as one parameter, so the statement stays prepared.
    listRuns: db.prepare(
      `SELECT id, payload FROM runs
       WHERE @states IS NULL OR state IN (SELECT value FROM json_each(@states))
       ORDER BY created_at, id`,
    ),
    insertRun: db.prepare(
      `INSERT INTO runs
         (id, action_plan_id, plan_id, task_id, task_revision, candidate_id, base_url, idempotency_key, state, prompt_id,
          grant_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateRun: db.prepare(
      "UPDATE runs SET state = ?, prompt_id = ?, updated_at = ?, payload = ? WHERE id = ? AND state = ?",
    ),

    maxEventSeq: db.prepare("SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?"),
    insertEvent: db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, from_state, to_state, principal, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    eventsForRun: db.prepare("SELECT run_id, seq, payload FROM run_events WHERE run_id = ? ORDER BY seq"),

    evaluation: db.prepare("SELECT id, payload FROM evaluations WHERE id = ?"),
    insertEvaluation: db.prepare(
      `INSERT INTO evaluations (id, run_id, criterion_id, evaluator_id, verdict, source, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    evaluationsForRun: db.prepare("SELECT id, payload FROM evaluations WHERE run_id = ? ORDER BY created_at, id"),

    acquisition: db.prepare("SELECT id, run_id, payload FROM acquisitions WHERE id = ?"),
    // rowid order is creation order, which is the order of the action plan's manifest.
    acquisitionsForRun: db.prepare("SELECT id, run_id, payload FROM acquisitions WHERE run_id = ? ORDER BY rowid"),
    insertAcquisition: db.prepare(
      `INSERT INTO acquisitions (id, run_id, state, folder, file, sha256, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateAcquisition: db.prepare("UPDATE acquisitions SET state = ?, updated_at = ?, payload = ? WHERE id = ? AND state = ?"),

    lease: db.prepare(
      "SELECT pool, owner_id, run_id, acquired_at, heartbeat_at, expires_at FROM resource_leases WHERE pool = ?",
    ),
    putLease: db.prepare(
      `INSERT INTO resource_leases (pool, owner_id, run_id, acquired_at, heartbeat_at, expires_at)
       VALUES (@pool, @ownerId, @runId, @acquiredAt, @heartbeatAt, @expiresAt)
       ON CONFLICT(pool) DO UPDATE SET
         owner_id = excluded.owner_id,
         run_id = excluded.run_id,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at`,
    ),
    heartbeatLease: db.prepare(
      "UPDATE resource_leases SET heartbeat_at = ?, expires_at = ? WHERE pool = ? AND owner_id = ?",
    ),
    releaseLease: db.prepare("DELETE FROM resource_leases WHERE pool = ? AND owner_id = ?"),
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

  /**
   * Run `fn` in a transaction that takes the write lock before its first read. Every
   * check-then-write on execution records uses it: in WAL mode a deferred transaction reads a
   * snapshot that another connection's commit can overtake before this one writes, so the
   * check would hold for a state that no longer exists.
   */
  private immediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
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

  // -------------------------------------------------------------------------------------
  // Action plans and approval (spec §14.2; ARCH milestone 3, action plans and grants)

  /**
   * Store an action plan. It is what a request and a grant bind by hash, so it is
   * immutable: the same plan again is a no-op, another one under the same id is refused.
   * The plan, candidate and task revision it names must belong together.
   */
  putActionPlan(input: z.input<typeof ActionPlan>): ActionPlan {
    const actionPlan = ActionPlan.parse(input);
    const payload = canonicalJson(actionPlan);
    return this.immediate(() => {
      const existing = parseRow(IdPayloadRow, this.stmts.actionPlan.get(actionPlan.id));
      if (existing) {
        const stored = readStored("actionPlan", existing.payload, { id: existing.id });
        if (canonicalJson(stored) === payload) return actionPlan;
        throw new StoreConflictError(`action plan ${actionPlan.id} is already stored with different content`);
      }
      const plan = parseRow(PlanTargetRow, this.stmts.planTarget.get(actionPlan.planId));
      if (plan && (plan.task_id !== actionPlan.taskId || plan.task_revision !== actionPlan.taskRevision)) {
        throw new StoreConflictError(
          `action plan ${actionPlan.id} names task ${actionPlan.taskId} revision ${actionPlan.taskRevision}, but plan ${actionPlan.planId} was made for ${plan.task_id} revision ${plan.task_revision}`,
        );
      }
      const candidate = parseRow(CandidatePlanRow, this.stmts.candidatePlan.get(actionPlan.candidateId));
      if (candidate && candidate.plan_id !== actionPlan.planId) {
        throw new StoreConflictError(
          `candidate ${actionPlan.candidateId} belongs to plan ${candidate.plan_id}, not ${actionPlan.planId}`,
        );
      }
      // A plan or candidate that isn't stored at all is left to the foreign keys.
      this.stmts.insertActionPlan.run(
        actionPlan.id,
        actionPlan.planId,
        actionPlan.taskId,
        actionPlan.taskRevision,
        actionPlan.candidateId,
        actionPlan.environmentId,
        actionPlan.target.baseUrl,
        actionPlan.hash,
        utc(actionPlan.createdAt),
        utc(actionPlan.expiresAt),
        payload,
      );
      return actionPlan;
    });
  }

  /** An action plan by id; undefined when not stored. */
  getActionPlan(id: string): ActionPlan | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.actionPlan.get(id));
    return row && readStored("actionPlan", row.payload, { id: row.id });
  }

  /**
   * Open an approval request. It opens `pending` and changes only through
   * `resolveApprovalRequest`; the same request again is a no-op. Its hash must be the
   * stored action plan's, so a request can't ask approval for something the plan isn't.
   */
  putApprovalRequest(input: z.input<typeof ApprovalRequest>): ApprovalRequest {
    const request = ApprovalRequest.parse(input);
    const payload = canonicalJson(request);
    return this.immediate(() => {
      const existing = parseRow(IdPayloadRow, this.stmts.approvalRequest.get(request.id));
      if (existing) {
        const stored = readStored("approvalRequest", existing.payload, { id: existing.id });
        if (canonicalJson(stored) === payload) return request;
        throw new StoreConflictError(`approval request ${request.id} is already stored with different content`);
      }
      if (request.state !== "pending") {
        throw new StoreConflictError(`approval request ${request.id} must open pending, not ${request.state}`);
      }
      const actionPlan = this.getActionPlan(request.actionPlanId);
      if (!actionPlan) throw new StoreConflictError(`action plan ${request.actionPlanId} is not stored`);
      if (actionPlan.hash !== request.actionPlanHash) {
        throw new StoreConflictError(`approval request ${request.id} names a hash action plan ${actionPlan.id} doesn't have`);
      }
      this.stmts.insertApprovalRequest.run(
        request.id,
        request.actionPlanId,
        request.actionPlanHash,
        request.state,
        utc(request.createdAt),
        utc(request.expiresAt),
        null,
        payload,
      );
      return request;
    });
  }

  /** An approval request by id; undefined when not stored. */
  getApprovalRequest(id: string): ApprovalRequest | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.approvalRequest.get(id));
    return row && readStored("approvalRequest", row.payload, { id: row.id });
  }

  /** Requests still waiting for the user, oldest first: what the terminal command lists. */
  listPendingRequests(now: Date): ApprovalRequest[] {
    return this.stmts.pendingRequests.all(now.toISOString()).map((value) => {
      const row = IdPayloadRow.parse(value);
      return readStored("approvalRequest", row.payload, { id: row.id });
    });
  }

  /** The newest approval request opened for an action plan, whatever its state. */
  latestRequestFor(actionPlanId: string): ApprovalRequest | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.requestsForActionPlan.get(actionPlanId));
    return row && readStored("approvalRequest", row.payload, { id: row.id });
  }

  /**
   * Resolve a pending request. Only `pending` resolves, so a declined request can't later
   * be granted and a granted one can't be taken back into a second grant; a request past
   * its expiry can't be granted. Anything else is a StoreConflictError.
   */
  resolveApprovalRequest(id: string, state: Exclude<ApprovalRequestState, "pending">, at: Date): ApprovalRequest {
    return this.immediate(() => {
      const current = this.getApprovalRequest(id);
      if (!current) throw new StoreConflictError(`approval request ${id} is not stored`);
      if (current.state !== "pending") {
        throw new StoreConflictError(`approval request ${id} is already ${current.state}`);
      }
      if (state === "granted" && at.getTime() >= Date.parse(current.expiresAt)) {
        throw new StoreConflictError(`approval request ${id} expired at ${current.expiresAt}`);
      }
      const resolvedAt = at.toISOString();
      const resolved = ApprovalRequest.parse({ ...current, state, resolvedAt });
      const result = this.stmts.resolveApprovalRequest.run(state, resolvedAt, canonicalJson(resolved), id);
      if (result.changes !== 1) throw new StoreConflictError(`approval request ${id} changed while it was resolved`);
      return resolved;
    });
  }

  /**
   * Store a grant for a granted request. It must bind what its request and action plan
   * bind (plan, hash, target) and may not allow more runs or wall time than the plan asks
   * for. A new grant is unconsumed: consumption happens only in `createRunWithGrant`.
   */
  putGrant(input: z.input<typeof ApprovalGrant>): ApprovalGrant {
    const grant = ApprovalGrant.parse(input);
    const payload = canonicalJson(grant);
    return this.immediate(() => {
      const existing = parseRow(IdPayloadRow, this.stmts.grant.get(grant.id));
      if (existing) {
        const stored = readStored("approvalGrant", existing.payload, { id: existing.id });
        if (canonicalJson(stored) === payload) return grant;
        throw new StoreConflictError(`grant ${grant.id} is already stored with different content`);
      }
      if (grant.consumedAt !== undefined) {
        throw new StoreConflictError(`grant ${grant.id} can't be stored as already consumed`);
      }
      const request = this.getApprovalRequest(grant.approvalRequestId);
      if (!request) throw new StoreConflictError(`approval request ${grant.approvalRequestId} is not stored`);
      if (request.state !== "granted") {
        throw new StoreConflictError(`approval request ${request.id} is ${request.state}, not granted`);
      }
      if (request.actionPlanId !== grant.actionPlanId || request.actionPlanHash !== grant.actionPlanHash) {
        throw new StoreConflictError(`grant ${grant.id} binds another action plan than request ${request.id}`);
      }
      const actionPlan = this.getActionPlan(grant.actionPlanId);
      if (!actionPlan) throw new StoreConflictError(`action plan ${grant.actionPlanId} is not stored`);
      if (actionPlan.target.baseUrl !== grant.target.baseUrl) {
        throw new StoreConflictError(
          `grant ${grant.id} names target ${grant.target.baseUrl}, the plan ${actionPlan.target.baseUrl}`,
        );
      }
      if (
        grant.limits.maxRuns > actionPlan.budgets.maxRuns ||
        grant.limits.maxWallTimeSeconds > actionPlan.budgets.maxWallTimeSeconds
      ) {
        throw new StoreConflictError(`grant ${grant.id} allows more than action plan ${actionPlan.id} asks for`);
      }
      this.stmts.insertGrant.run(
        grant.id,
        grant.approvalRequestId,
        grant.actionPlanId,
        grant.actionPlanHash,
        grant.target.baseUrl,
        grant.channel,
        utc(grant.issuedAt),
        utc(grant.expiresAt),
        payload,
      );
      return grant;
    });
  }

  /** A grant by id; undefined when not stored. */
  getGrant(id: string): ApprovalGrant | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.grant.get(id));
    return row && readStored("approvalGrant", row.payload, { id: row.id });
  }

  /**
   * The newest grant that could start a run of this action plan now: same plan, hash and
   * target, unconsumed, not expired. Undefined when there is none. Tools never take a grant
   * as input; they name an action plan and the store finds its grant (ARCH milestone 3).
   */
  findUsableGrant(query: {
    actionPlanId: string;
    actionPlanHash: string;
    baseUrl: string;
    now: Date;
  }): ApprovalGrant | undefined {
    const row = parseRow(
      IdPayloadRow,
      this.stmts.usableGrant.get(query.actionPlanId, query.actionPlanHash, query.baseUrl, query.now.toISOString()),
    );
    if (!row) return undefined;
    const grant = readStored("approvalGrant", row.payload, { id: row.id });
    // The row matched on its columns; a payload that says otherwise was edited, and
    // returning it would hand out a grant for something else.
    if (
      grant.actionPlanId !== query.actionPlanId ||
      grant.actionPlanHash !== query.actionPlanHash ||
      grant.target.baseUrl !== query.baseUrl ||
      grant.consumedAt !== undefined ||
      query.now.getTime() >= Date.parse(grant.expiresAt)
    ) {
      throw new StoredRecordError("approvalGrant", `payload of row ${row.id} disagrees with its columns`);
    }
    return grant;
  }

  // -------------------------------------------------------------------------------------
  // Runs and their events (spec §15.3, §15.4; ARCH milestone 3, run controller)

  /**
   * Create a run under a grant and consume the grant, in one transaction that takes the
   * write lock first, so one grant never starts two runs, from this connection or another
   * (spec §14.2). The run starts in PREPARING: it is created at start, when the user has
   * already approved, so no stored run sits in AWAITING_APPROVAL. Refused with a
   * StoreConflictError: a grant that is missing, consumed, expired, or bound to another
   * action plan, hash or target; an expired action plan; a run whose identity or graph isn't
   * its action plan's; an idempotency key that already has a run. The creation is the run's
   * first event.
   */
  createRunWithGrant(args: {
    run: z.input<typeof RunRecord>;
    grantId: string;
    now: Date;
    principal?: RunPrincipal;
    reason?: string;
  }): { run: RunRecord; grant: ApprovalGrant; event: RunEvent } {
    if (args.run.grantId !== undefined && args.run.grantId !== args.grantId) {
      throw new StoreConflictError(`run ${args.run.id} names grant ${args.run.grantId}, not ${args.grantId}`);
    }
    const run = RunRecord.parse({ ...args.run, grantId: args.grantId });
    if (run.state !== "PREPARING") {
      throw new StoreConflictError(`run ${run.id} must start in PREPARING, not ${run.state}`);
    }
    const now = args.now.getTime();
    return this.immediate(() => {
      const grant = this.getGrant(args.grantId);
      if (!grant) throw new StoreConflictError(`grant ${args.grantId} is not stored`);
      if (grant.consumedByRunId !== undefined) {
        throw new StoreConflictError(`grant ${grant.id} was already consumed by run ${grant.consumedByRunId}`);
      }
      if (now >= Date.parse(grant.expiresAt)) throw new StoreConflictError(`grant ${grant.id} expired at ${grant.expiresAt}`);
      const actionPlan = this.getActionPlan(run.actionPlanId);
      if (!actionPlan) throw new StoreConflictError(`action plan ${run.actionPlanId} is not stored`);
      if (now >= Date.parse(actionPlan.expiresAt)) {
        throw new StoreConflictError(`action plan ${actionPlan.id} expired at ${actionPlan.expiresAt}`);
      }
      if (grant.actionPlanId !== actionPlan.id || grant.actionPlanHash !== actionPlan.hash) {
        throw new StoreConflictError(`grant ${grant.id} doesn't bind action plan ${actionPlan.id} as it is stored`);
      }
      if (grant.target.baseUrl !== run.target.baseUrl || actionPlan.target.baseUrl !== run.target.baseUrl) {
        throw new StoreConflictError(`run ${run.id} targets ${run.target.baseUrl}, the grant ${grant.target.baseUrl}`);
      }
      if (
        run.planId !== actionPlan.planId ||
        run.taskId !== actionPlan.taskId ||
        run.taskRevision !== actionPlan.taskRevision ||
        run.candidateId !== actionPlan.candidateId ||
        !actionPlan.effects.some((e) => e.kind === "local_render" && e.graphFingerprint === run.graphFingerprint)
      ) {
        throw new StoreConflictError(`run ${run.id} isn't what action plan ${actionPlan.id} describes`);
      }
      const prior = this.findRunByIdempotencyKey(run.idempotencyKey);
      if (prior) throw new StoreConflictError(`idempotency key ${run.idempotencyKey} already maps to run ${prior.id}`);

      const at = args.now.toISOString();
      // The run first: the grant's consumed_by_run_id references it.
      this.stmts.insertRun.run(
        run.id,
        run.actionPlanId,
        run.planId,
        run.taskId,
        run.taskRevision,
        run.candidateId,
        run.target.baseUrl,
        run.idempotencyKey,
        run.state,
        run.promptId ?? null,
        args.grantId,
        utc(run.createdAt),
        utc(run.updatedAt),
        canonicalJson(run),
      );
      const consumed = ApprovalGrant.parse({ ...grant, consumedAt: at, consumedByRunId: run.id });
      const result = this.stmts.consumeGrant.run(utc(at), run.id, canonicalJson(consumed), grant.id);
      if (result.changes !== 1) throw new StoreConflictError(`grant ${grant.id} was consumed concurrently`);
      const event = this.insertEvent({
        runId: run.id,
        at,
        kind: "transition",
        to: run.state,
        principal: args.principal ?? "controller",
        reason: args.reason ?? `started under grant ${grant.id}`,
      });
      return { run, grant: consumed, event };
    });
  }

  /** A run by id; undefined when not stored. */
  getRun(id: string): RunRecord | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.run.get(id));
    return row && readStored("run", row.payload, { id: row.id });
  }

  /** The run an idempotency key maps to; undefined when the key has none (spec §15.4). */
  findRunByIdempotencyKey(key: string): RunRecord | undefined {
    const row = parseRow(IdPayloadRow, this.stmts.runByIdempotencyKey.get(key));
    return row && readStored("run", row.payload, { id: row.id });
  }

  /** Runs, oldest first; only those in `states` when given (the controller resumes non-final runs). */
  listRuns(filter: { states?: readonly RunState[] } = {}): RunRecord[] {
    const states = filter.states === undefined ? null : JSON.stringify(filter.states.map((s) => RunState.parse(s)));
    return this.stmts.listRuns.all({ states }).map((value) => {
      const row = IdPayloadRow.parse(value);
      return readStored("run", row.payload, { id: row.id });
    });
  }

  /**
   * Move a run from `from` to `to` and record why, in one transaction: the current state
   * must still be `from` (compare and set, so two controllers can't both advance a run),
   * the state machine must allow the edge, and the `transition` event is written with the
   * state, so it exists before anyone can announce the progress (spec §15.3). A changed
   * state is a StoreConflictError, a forbidden edge an IllegalTransitionError. A patch may
   * set the prompt ID once but never change it, since reconciliation keys on it.
   */
  transitionRun(args: {
    runId: string;
    from: RunState;
    to: RunState;
    principal: RunPrincipal;
    reason: string;
    patch?: RunPatch;
    data?: Record<string, unknown>;
    at: Date;
  }): { run: RunRecord; event: RunEvent } {
    if (!canTransition(args.from, args.to)) throw new IllegalTransitionError(args.from, args.to);
    const patch = RunPatch.parse(args.patch ?? {});
    const at = args.at.toISOString();
    return this.immediate(() => {
      const current = this.getRun(args.runId);
      if (!current) throw new StoreConflictError(`run ${args.runId} is not stored`);
      if (current.state !== args.from) {
        throw new StoreConflictError(`run ${current.id} is ${current.state}, not ${args.from}`);
      }
      if (patch.promptId !== undefined && current.promptId !== undefined && patch.promptId !== current.promptId) {
        throw new StoreConflictError(`run ${current.id} already has prompt ID ${current.promptId}`);
      }
      const { error: _previous, ...rest } = current;
      const error = patch.error === undefined ? current.error : patch.error === null ? undefined : patch.error;
      const next = RunRecord.parse({
        ...rest,
        ...(patch.promptId === undefined ? {} : { promptId: patch.promptId }),
        ...(patch.outputs === undefined ? {} : { outputs: patch.outputs }),
        ...(patch.acceptance === undefined ? {} : { acceptance: patch.acceptance }),
        timings: { ...current.timings, ...patch.timings },
        ...(error === undefined ? {} : { error }),
        state: args.to,
        updatedAt: at,
      });
      const result = this.stmts.updateRun.run(
        next.state,
        next.promptId ?? null,
        utc(at),
        canonicalJson(next),
        next.id,
        args.from,
      );
      if (result.changes !== 1) throw new StoreConflictError(`run ${current.id} changed while it was transitioned`);
      const event = this.insertEvent({
        runId: next.id,
        at,
        kind: "transition",
        from: args.from,
        to: args.to,
        principal: args.principal,
        reason: args.reason,
        ...(args.data === undefined ? {} : { data: args.data }),
      });
      return { run: next, event };
    });
  }

  /**
   * Claim the run's one submission (spec §15.4) and write its `submit_attempt` event with
   * the prompt ID, before the network call. The claim wins only while the run is VALIDATING
   * and has no attempt yet, checked and written under the write lock, so of two processes
   * on one database exactly one goes on to POST; the loser gets `won: false` and why.
   * Migration 3's unique index refuses a second attempt even from a writer that skipped
   * this check.
   */
  claimSubmission(args: { runId: string; promptId: string; at: Date }): { won: true; event: RunEvent } | { won: false; reason: string } {
    const promptId = z.string().uuid().parse(args.promptId);
    const at = args.at.toISOString();
    return this.immediate((): { won: true; event: RunEvent } | { won: false; reason: string } => {
      const current = this.getRun(args.runId);
      if (!current) throw new StoreConflictError(`run ${args.runId} is not stored`);
      if (current.state !== "VALIDATING") return { won: false, reason: `run ${current.id} is ${current.state}, not VALIDATING` };
      const attempt = this.listRunEvents(current.id).find((e) => e.kind === "submit_attempt");
      if (attempt) return { won: false, reason: `run ${current.id} already has a submission attempt (event ${attempt.seq})` };
      const event = this.insertEvent({
        runId: current.id,
        at,
        kind: "submit_attempt",
        principal: "controller",
        reason: `submitting prompt ${promptId} to ${current.target.baseUrl}`,
        data: { promptId },
      });
      return { won: true, event };
    });
  }

  /**
   * Change a COMPLETED run's acceptance, as the user's verdict after the run finished does
   * (spec §4.2: acceptance is kept apart from completion, so it can change while the state
   * can't). Refused with a StoreConflictError in every other state, where the run controller
   * owns the field. The `note` event records the old and the new acceptance, written in the
   * same transaction as the change.
   */
  setRunAcceptance(args: {
    runId: string;
    acceptance: Acceptance;
    principal: RunPrincipal;
    reason: string;
    at: Date;
  }): { run: RunRecord; event: RunEvent } {
    const acceptance = Acceptance.parse(args.acceptance);
    const principal = RunPrincipal.parse(args.principal);
    const at = args.at.toISOString();
    return this.immediate(() => {
      const current = this.getRun(args.runId);
      if (!current) throw new StoreConflictError(`run ${args.runId} is not stored`);
      if (current.state !== "COMPLETED") {
        throw new StoreConflictError(`run ${current.id} is ${current.state}; acceptance changes here only on a COMPLETED run`);
      }
      const next = RunRecord.parse({ ...current, acceptance, updatedAt: at });
      const result = this.stmts.updateRun.run(
        next.state,
        next.promptId ?? null,
        utc(at),
        canonicalJson(next),
        next.id,
        "COMPLETED",
      );
      if (result.changes !== 1) throw new StoreConflictError(`run ${current.id} changed while its acceptance was set`);
      const event = this.insertEvent({
        runId: next.id,
        at,
        kind: "note",
        principal,
        reason: args.reason,
        data: { previousAcceptance: current.acceptance, acceptance },
      });
      return { run: next, event };
    });
  }

  /**
   * Record an event that changes no state: a submission's result, a reconciliation, a
   * cancellation request, a note. Transitions go through `transitionRun`, which writes their
   * event with the state; the submission attempt goes through `claimSubmission`, which
   * decides whether there may be one.
   */
  appendRunEvent(args: {
    runId: string;
    kind: Exclude<RunEventKind, "transition" | "submit_attempt">;
    principal: RunPrincipal;
    reason: string;
    data?: Record<string, unknown>;
    at: Date;
  }): RunEvent {
    const kind = RunEventKind.parse(args.kind);
    if (kind === "transition") throw new StoreConflictError("a transition event is written by transitionRun");
    if (kind === "submit_attempt") throw new StoreConflictError("a submission attempt is written by claimSubmission");
    return this.immediate(() => {
      if (!this.getRun(args.runId)) throw new StoreConflictError(`run ${args.runId} is not stored`);
      return this.insertEvent({
        runId: args.runId,
        at: args.at.toISOString(),
        kind,
        principal: args.principal,
        reason: args.reason,
        ...(args.data === undefined ? {} : { data: args.data }),
      });
    });
  }

  /** A run's events in order; empty when the run has none or isn't stored. */
  listRunEvents(runId: string): RunEvent[] {
    return this.stmts.eventsForRun.all(runId).map((value) => readEvent(EventRow.parse(value)));
  }

  /** Append an event with the run's next seq. Callers hold the write lock (`immediate`). */
  private insertEvent(fields: Omit<z.input<typeof RunEvent>, "schemaVersion" | "seq">): RunEvent {
    const last = parseRow(MaxSeqRow, this.stmts.maxEventSeq.get(fields.runId));
    const event = RunEvent.parse({ ...fields, schemaVersion: ARCHITECT_SCHEMA_VERSION, seq: (last?.seq ?? 0) + 1 });
    this.stmts.insertEvent.run(
      event.runId,
      event.seq,
      utc(event.at),
      event.kind,
      event.from ?? null,
      event.to ?? null,
      event.principal,
      canonicalJson(event),
    );
    return event;
  }

  // -------------------------------------------------------------------------------------
  // Evaluations (spec §13.2)

  /** Store an evaluation. A verdict once recorded doesn't change: the same one again is a no-op. */
  putEvaluation(input: z.input<typeof EvaluationRecord>): EvaluationRecord {
    const evaluation = EvaluationRecord.parse(input);
    const payload = canonicalJson(evaluation);
    return this.transaction(() => {
      const existing = parseRow(IdPayloadRow, this.stmts.evaluation.get(evaluation.id));
      if (existing) {
        const stored = readStored("evaluation", existing.payload, { id: existing.id });
        if (canonicalJson(stored) === payload) return evaluation;
        throw new StoreConflictError(`evaluation ${evaluation.id} is already stored with different content`);
      }
      this.stmts.insertEvaluation.run(
        evaluation.id,
        evaluation.runId,
        evaluation.criterionId,
        evaluation.evaluatorId,
        evaluation.verdict,
        evaluation.source,
        utc(evaluation.createdAt),
        payload,
      );
      return evaluation;
    });
  }

  /** A run's evaluations, oldest first. */
  listEvaluations(runId: string): EvaluationRecord[] {
    return this.stmts.evaluationsForRun.all(runId).map((value) => {
      const row = IdPayloadRow.parse(value);
      return readStored("evaluation", row.payload, { id: row.id });
    });
  }

  // -------------------------------------------------------------------------------------
  // Acquisitions (TODO 4.2.2, 4.5; ARCH 2026-11-16, placement)

  /**
   * Create one `planned` acquisition per file of the run's `acquire_models` effect, in one
   * transaction that takes the write lock first. The files come from the run's action plan,
   * the one the grant bound, never from the caller, so a run acquires exactly what the user
   * approved. Calling it again for the same run returns the records already there when they
   * cover the same files (a restart in PREPARING); any other existing set is a
   * StoreConflictError, as are a missing run or action plan, an action plan without the
   * effect, and a run no longer in PREPARING.
   */
  createAcquisitions(args: { runId: string; now: Date; newId: () => string }): AcquisitionRecord[] {
    const at = args.now.toISOString();
    return this.immediate(() => {
      const run = this.getRun(args.runId);
      if (!run) throw new StoreConflictError(`run ${args.runId} is not stored`);
      const actionPlan = this.getActionPlan(run.actionPlanId);
      if (!actionPlan) throw new StoreConflictError(`action plan ${run.actionPlanId} is not stored`);
      const effect = actionPlan.effects.find((e): e is AcquireModelsEffect => e.kind === "acquire_models");
      if (!effect) throw new StoreConflictError(`action plan ${actionPlan.id} acquires no model files`);
      const key = (f: { folder: string; file: string; source: unknown; destinationRoot: string }) =>
        canonicalJson({ folder: f.folder, file: f.file, source: f.source, destinationRoot: f.destinationRoot });
      const existing = this.listAcquisitions(run.id);
      if (existing.length > 0) {
        const want = effect.files.map(key).sort();
        const have = existing.map(key).sort();
        if (want.length === have.length && want.every((k, i) => k === have[i])) return existing;
        throw new StoreConflictError(`run ${run.id} already has acquisitions for other files than its action plan names`);
      }
      if (run.state !== "PREPARING") {
        throw new StoreConflictError(`run ${run.id} is ${run.state}; acquisitions are created in PREPARING`);
      }
      return effect.files.map((f) => {
        const record = AcquisitionRecord.parse({
          schemaVersion: ARCHITECT_SCHEMA_VERSION,
          id: `acq-${args.newId()}`,
          runId: run.id,
          actionPlanId: actionPlan.id,
          folder: f.folder,
          file: f.file,
          source: f.source,
          destinationRoot: f.destinationRoot,
          state: "planned",
          createdAt: at,
          updatedAt: at,
        });
        this.stmts.insertAcquisition.run(
          record.id,
          record.runId,
          record.state,
          record.folder,
          record.file,
          record.source.sha256,
          utc(record.createdAt),
          utc(record.updatedAt),
          canonicalJson(record),
        );
        return record;
      });
    });
  }

  /** An acquisition by id; undefined when not stored. */
  getAcquisition(id: string): AcquisitionRecord | undefined {
    const row = this.stmts.acquisition.get(id);
    return row === undefined ? undefined : readAcquisition(row);
  }

  /** A run's acquisitions in manifest order; empty when it has none. */
  listAcquisitions(runId: string): AcquisitionRecord[] {
    return this.stmts.acquisitionsForRun.all(runId).map(readAcquisition);
  }

  /**
   * Move an acquisition from `from` to `to`, compare and set like `transitionRun`: the table
   * must allow the edge (else IllegalAcquisitionTransitionError) and the stored state must
   * still be `from` (else StoreConflictError). The new state is written before this returns,
   * so nothing is reported that isn't stored. The record schema refuses a `placed` record
   * whose observed sha256 or size isn't the pinned one, and a `failed` one without an error.
   */
  transitionAcquisition(args: {
    id: string;
    from: AcquisitionState;
    to: AcquisitionState;
    patch?: AcquisitionPatch;
    at: Date;
  }): AcquisitionRecord {
    const from = AcquisitionState.parse(args.from);
    const to = AcquisitionState.parse(args.to);
    if (!canAcquisitionTransition(from, to)) throw new IllegalAcquisitionTransitionError(from, to);
    const patch = AcquisitionPatch.parse(args.patch ?? {});
    const at = args.at.toISOString();
    return this.immediate(() => {
      const current = this.getAcquisition(args.id);
      if (!current) throw new StoreConflictError(`acquisition ${args.id} is not stored`);
      if (current.state !== from) throw new StoreConflictError(`acquisition ${current.id} is ${current.state}, not ${from}`);
      const next: Record<string, unknown> = { ...current, state: to, updatedAt: at };
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) delete next[field];
        else next[field] = value;
      }
      const record = AcquisitionRecord.parse(next);
      const result = this.stmts.updateAcquisition.run(record.state, utc(at), canonicalJson(record), record.id, from);
      if (result.changes !== 1) throw new StoreConflictError(`acquisition ${current.id} changed while it was transitioned`);
      return record;
    });
  }

  // -------------------------------------------------------------------------------------
  // Resource leases (spec §11.3; ARCH milestone 3, resources)

  /** The lease on a pool; undefined when nobody holds it. */
  getLease(pool: string): ResourceLease | undefined {
    return leaseFromRow(this.stmts.lease.get(pool));
  }

  /**
   * Take the lease on a pool for `ttlMs`. A free pool is taken. The same owner for the same
   * run renews its lease; the same owner for another run is busy like anyone else, because
   * one render runs per pool. Another holder's unexpired lease is busy; an expired one is
   * taken over and returned as `tookOverFrom`, so the caller can record whose lease lapsed.
   */
  acquireLease(args: { pool: string; ownerId: string; runId?: string; now: Date; ttlMs: number }): LeaseAcquisition {
    const ttl = LeaseTtl.parse(args.ttlMs);
    const at = args.now.toISOString();
    const lease = ResourceLease.parse({
      pool: args.pool,
      ownerId: args.ownerId,
      ...(args.runId === undefined ? {} : { runId: args.runId }),
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: new Date(args.now.getTime() + ttl).toISOString(),
    });
    return this.immediate((): LeaseAcquisition => {
      const holder = this.getLease(lease.pool);
      const write = (l: ResourceLease) =>
        this.stmts.putLease.run({
          pool: l.pool,
          ownerId: l.ownerId,
          runId: l.runId ?? null,
          acquiredAt: utc(l.acquiredAt),
          heartbeatAt: utc(l.heartbeatAt),
          expiresAt: utc(l.expiresAt),
        });
      if (!holder) {
        write(lease);
        return { acquired: true, lease };
      }
      if (holder.ownerId === lease.ownerId && holder.runId === lease.runId) {
        const renewed = { ...lease, acquiredAt: holder.acquiredAt };
        write(renewed);
        return { acquired: true, lease: renewed };
      }
      if (args.now.getTime() < Date.parse(holder.expiresAt)) return { acquired: false, holder };
      write(lease);
      return { acquired: true, lease, tookOverFrom: holder };
    });
  }

  /**
   * Extend the owner's lease by `ttlMs` from `now`. Only the owner may: another owner's
   * heartbeat, or one for a pool nobody holds, is a StoreConflictError. A lapsed lease that
   * nobody took over is still the owner's row, so its heartbeat extends it.
   */
  heartbeatLease(args: { pool: string; ownerId: string; now: Date; ttlMs: number }): ResourceLease {
    const ttl = LeaseTtl.parse(args.ttlMs);
    return this.immediate(() => {
      const holder = this.getLease(args.pool);
      if (!holder) throw new StoreConflictError(`pool ${args.pool} has no lease`);
      if (holder.ownerId !== args.ownerId) {
        throw new StoreConflictError(`pool ${args.pool} is leased by ${holder.ownerId}, not ${args.ownerId}`);
      }
      const next = ResourceLease.parse({
        ...holder,
        heartbeatAt: args.now.toISOString(),
        expiresAt: new Date(args.now.getTime() + ttl).toISOString(),
      });
      this.stmts.heartbeatLease.run(utc(next.heartbeatAt), utc(next.expiresAt), args.pool, args.ownerId);
      return next;
    });
  }

  /** Release the owner's lease. Returns whether this owner held it; another owner's lease stays. */
  releaseLease(args: { pool: string; ownerId: string }): boolean {
    return this.stmts.releaseLease.run(args.pool, args.ownerId).changes === 1;
  }
}
