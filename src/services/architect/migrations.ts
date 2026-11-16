// The numbered migrations of `architect.db` (spec §15.1, §15.2; ARCH decision log,
// 2026-11-15). They live in code rather than in files next to the package, so the schema a
// build expects ships inside the build.
//
// Rules for adding one: append, never edit or renumber an applied migration, because a
// database that has applied version N trusts that version N means the same SQL forever. The
// store applies each migration in its own transaction and records it in
// `schema_migrations`.
//
// Relational columns carry identity, status, target and time, so they can be indexed and
// constrained; the full record is JSON in `payload`, versioned by its own `schemaVersion`
// and read back through `parseStored` (spec §15.2). Milestone 2 creates the planning
// tables, milestone 3 the execution tables, milestone 4 the acquisitions, milestone 5 the
// model observations and the source registry; the other spec §15.2 tables arrive with the
// milestones that write them.

/** One schema step: applied once, in order, inside its own transaction. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** The bookkeeping table. Created before any migration runs, so it is not one itself. */
export const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/** Every migration this build knows, in version order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "planning_tables",
    sql: `
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE task_revisions (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  revision   INTEGER NOT NULL CHECK (revision >= 1),
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);

CREATE TABLE environments (
  id                 TEXT PRIMARY KEY,
  base_url           TEXT NOT NULL,
  captured_at        TEXT NOT NULL,
  node_schema_digest TEXT,
  payload            TEXT NOT NULL
);

CREATE TABLE catalog_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('bundled', 'local', 'fixture')),
  root            TEXT NOT NULL,
  trust           TEXT NOT NULL CHECK (trust IN ('maintainer', 'user', 'test')),
  last_refresh_at TEXT
);

CREATE TABLE recipes (
  id            TEXT NOT NULL,
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  source_id     TEXT NOT NULL REFERENCES catalog_sources(id),
  content_hash  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  certification TEXT NOT NULL,
  payload       TEXT NOT NULL,
  loaded_at     TEXT NOT NULL,
  PRIMARY KEY (id, revision)
);

-- A plan is made for one task revision; the composite key keeps it from naming a revision
-- that was never stored.
CREATE TABLE plans (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  task_revision  INTEGER NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  state          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  FOREIGN KEY (task_id, task_revision) REFERENCES task_revisions(task_id, revision)
);

CREATE TABLE plan_candidates (
  id         TEXT PRIMARY KEY,
  plan_id    TEXT NOT NULL REFERENCES plans(id),
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);

CREATE INDEX plans_task_id ON plans(task_id);
CREATE INDEX plans_state ON plans(state);
CREATE INDEX environments_base_url_captured_at ON environments(base_url, captured_at);
CREATE INDEX plan_candidates_plan_id ON plan_candidates(plan_id);
`,
  },
  {
    // Milestone 3 (TODO 3.1.2). State columns carry no CHECK of their values: SQLite can't
    // alter a CHECK without rebuilding the table, and the Zod enums are the authority that
    // every write passes first. Spec §15.2's `operations` table is left out until something
    // writes it: runs carry their own idempotency key, and downloads and installs come later.
    version: 2,
    name: "execution_tables",
    sql: `
-- An action plan is immutable: a changed plan has another hash and is another record.
CREATE TABLE action_plans (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES plans(id),
  task_id        TEXT NOT NULL,
  task_revision  INTEGER NOT NULL,
  candidate_id   TEXT NOT NULL REFERENCES plan_candidates(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  base_url       TEXT NOT NULL,
  hash           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  FOREIGN KEY (task_id, task_revision) REFERENCES task_revisions(task_id, revision)
);

CREATE TABLE approval_requests (
  id               TEXT PRIMARY KEY,
  action_plan_id   TEXT NOT NULL REFERENCES action_plans(id),
  action_plan_hash TEXT NOT NULL,
  state            TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  resolved_at      TEXT,
  payload          TEXT NOT NULL
);

-- One grant per request, and consumption recorded in columns as well as the payload, so
-- the "unconsumed" test is one indexed condition inside the transaction that consumes.
CREATE TABLE approval_grants (
  id                  TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
  action_plan_id      TEXT NOT NULL REFERENCES action_plans(id),
  action_plan_hash    TEXT NOT NULL,
  base_url            TEXT NOT NULL,
  channel             TEXT NOT NULL,
  issued_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  consumed_at         TEXT,
  consumed_by_run_id  TEXT REFERENCES runs(id),
  payload             TEXT NOT NULL,
  CHECK ((consumed_at IS NULL) = (consumed_by_run_id IS NULL))
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  action_plan_id  TEXT NOT NULL REFERENCES action_plans(id),
  plan_id         TEXT NOT NULL REFERENCES plans(id),
  task_id         TEXT NOT NULL,
  task_revision   INTEGER NOT NULL,
  candidate_id    TEXT NOT NULL REFERENCES plan_candidates(id),
  base_url        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state           TEXT NOT NULL,
  prompt_id       TEXT,
  grant_id        TEXT REFERENCES approval_grants(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  payload         TEXT NOT NULL
);

-- The state change and its event are written in one transaction (spec §15.3); the key
-- keeps two writers from both appending the same seq.
CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  principal  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE evaluations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  criterion_id TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  payload      TEXT NOT NULL
);

-- One row per memory pool is the lease: holding the row is holding the pool.
CREATE TABLE resource_leases (
  pool         TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  run_id       TEXT REFERENCES runs(id),
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- spec §15.4: one idempotency key, one run. Every run has a key, so the index is total.
CREATE UNIQUE INDEX runs_idempotency_key ON runs(idempotency_key);
-- Reconciliation finds a run by the prompt ID ComfyUI reports; two runs must not share one.
CREATE UNIQUE INDEX runs_prompt_id ON runs(prompt_id) WHERE prompt_id IS NOT NULL;
-- One grant starts one run, seen from both sides.
CREATE UNIQUE INDEX runs_grant_id ON runs(grant_id) WHERE grant_id IS NOT NULL;
CREATE UNIQUE INDEX approval_grants_consumed_by_run_id ON approval_grants(consumed_by_run_id)
  WHERE consumed_by_run_id IS NOT NULL;

CREATE INDEX action_plans_plan_id ON action_plans(plan_id);
CREATE INDEX approval_requests_action_plan_id ON approval_requests(action_plan_id);
CREATE INDEX approval_grants_binding ON approval_grants(action_plan_id, action_plan_hash, base_url);
CREATE INDEX runs_state ON runs(state);
CREATE INDEX runs_action_plan_id ON runs(action_plan_id);
CREATE INDEX evaluations_run_id ON evaluations(run_id);
`,
  },
  {
    version: 3,
    name: "one_submission_per_run",
    sql: `
-- spec §15.4: a run is submitted at most once. The store's claimSubmission checks this in
-- an IMMEDIATE transaction; the index keeps a second attempt out even if a writer skipped it.
CREATE UNIQUE INDEX run_events_one_submit_attempt ON run_events(run_id) WHERE kind = 'submit_attempt';
`,
  },
  {
    // Milestone 4 (TODO 4.2.2; ARCH 2026-11-16, placement): one row per model file a run
    // acquires. As in migration 2, the state column has no CHECK; the Zod enum and the
    // transition table are the authority. The unique index keeps a run from staging or
    // placing one destination twice, and as its first column is run_id it also serves the
    // per-run reads, so no separate run_id index is created.
    version: 4,
    name: "acquisitions",
    sql: `
CREATE TABLE acquisitions (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  state      TEXT NOT NULL,
  folder     TEXT NOT NULL,
  file       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);

CREATE UNIQUE INDEX acquisitions_run_folder_file ON acquisitions(run_id, folder, file);
`,
  },
  {
    // Milestone 5 (TODO 5.2, 5.3; ARCH 2026-11-16, model families and sources). One row per
    // observed model file, replaced when the file or the rules change; and the source
    // registry of spec §8.5. `family` is NULL when no single rule matched, which the
    // payload's outcome tells apart (no match, ambiguous, unreadable). As in migrations 2
    // and 4, state columns have no CHECK; the Zod schemas are the authority.
    version: 5,
    name: "model_observations_and_sources",
    sql: `
CREATE TABLE model_observations (
  folder      TEXT NOT NULL,
  file        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  mtime_ms    REAL NOT NULL,
  family      TEXT,
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload     TEXT NOT NULL
);

CREATE UNIQUE INDEX model_observations_folder_file ON model_observations(folder, file);

CREATE TABLE sources (
  id              TEXT PRIMARY KEY,
  adapter         TEXT NOT NULL,
  root            TEXT NOT NULL,
  allowed_ops     TEXT NOT NULL,
  trust           TEXT NOT NULL,
  refresh_policy  TEXT NOT NULL,
  last_refresh_at TEXT,
  state           TEXT NOT NULL,
  payload         TEXT NOT NULL
);
`,
  },
];
