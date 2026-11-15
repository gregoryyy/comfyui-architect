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
// and read back through `parseStored` (spec §15.2). Milestone 2 creates only the planning
// tables; the other spec §15.2 tables arrive with the milestones that write them.

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
];
