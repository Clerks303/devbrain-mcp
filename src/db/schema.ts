import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const DEVBRAIN_DIR = path.join(os.homedir(), '.devbrain');
export const DEFAULT_DB_PATH = path.join(DEVBRAIN_DIR, 'devbrain.db');
export const CONFIG_PATH = path.join(DEVBRAIN_DIR, 'config.json');

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

const VEC_TABLES = [
  'entity_embeddings',
  'observation_embeddings',
  'file_digest_embeddings',
  'issue_embeddings',
  'session_embeddings',
  'rule_embeddings',
  'lesson_embeddings',
] as const;

function getStoredDimension(db: Database.Database): number | null {
  try {
    const row = db.prepare(
      "SELECT value FROM meta WHERE key = 'embedding_dimension'"
    ).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : null;
  } catch {
    // meta table does not exist yet
    return null;
  }
}

function setStoredDimension(db: Database.Database, dimension: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dimension', ?)"
  ).run(String(dimension));
}

function recreateVecTables(db: Database.Database, dimension: number): void {
  for (const table of VEC_TABLES) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch {
      // table may not exist, ignore
    }
  }
  createVecTables(db, dimension);
}

function createVecTables(db: Database.Database, dimension: number): void {
  for (const table of VEC_TABLES) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    if (!exists) {
      db.exec(
        `CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY, embedding float[${dimension}] distance_metric=cosine)`
      );
    }
  }
}

export function initDatabase(dbPath: string, embeddingDimension: number = 1536): Database.Database {
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  sqliteVec.load(db);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      project_id TEXT,
      content TEXT,
      metadata TEXT,
      status TEXT DEFAULT 'unknown',
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      source TEXT,
      category TEXT DEFAULT 'note',
      embedding BLOB,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);

    CREATE TABLE IF NOT EXISTS file_digests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content_hash TEXT,
      summary TEXT,
      exports TEXT,
      imports TEXT,
      language TEXT,
      loc INTEGER,
      status TEXT DEFAULT 'active',
      embedding BLOB,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_digests_project_path ON file_digests(project_id, path);
    CREATE INDEX IF NOT EXISTS idx_file_digests_project_status ON file_digests(project_id, status);

    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      file_path TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'open',
      resolution TEXT,
      embedding BLOB,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_issues_project_type ON issues(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_issues_entity ON issues(entity_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal TEXT NOT NULL,
      summary TEXT,
      tool_calls INTEGER DEFAULT 0,
      entities_modified INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'global',
      pattern TEXT,
      content TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'should',
      embedding BLOB,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_project ON rules(project_id, scope);

    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      trigger_text TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'neutral',
      confidence REAL DEFAULT 0.5,
      occurrences INTEGER DEFAULT 1,
      embedding BLOB,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project_id, outcome);

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      description TEXT,
      data TEXT NOT NULL,
      entity_count INTEGER,
      relation_count INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);

    CREATE TABLE IF NOT EXISTS project_vision (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      description TEXT,
      features_json TEXT,
      stack_json TEXT,
      constraints_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_goals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT CHECK(priority IN ('P0','P1','P2','P3')) DEFAULT 'P1',
      status TEXT CHECK(status IN ('not_started','in_progress','done','blocked')) DEFAULT 'not_started',
      parent_goal_id TEXT REFERENCES project_goals(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_goals_project ON project_goals(project_id);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON project_goals(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_goals_parent ON project_goals(parent_goal_id);

    CREATE TABLE IF NOT EXISTS goal_entities (
      goal_id TEXT NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      role TEXT CHECK(role IN ('implements','blocks','depends_on','touches')) DEFAULT 'implements',
      PRIMARY KEY (goal_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_entities_entity ON goal_entities(entity_id);

    CREATE TABLE IF NOT EXISTS goal_missions (
      goal_id TEXT NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('success','partial','failed')),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (goal_id, mission_id)
    );
  `);

  // Trigger to auto-update updated_at on goal updates
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS project_goals_updated_at
      AFTER UPDATE ON project_goals
      FOR EACH ROW
      BEGIN
        UPDATE project_goals SET updated_at = datetime('now') WHERE id = OLD.id;
      END;
    `);
  } catch {
    // trigger may already exist
  }

  // Idempotent ALTER TABLE migrations
  try { db.exec("ALTER TABLE entities ADD COLUMN status TEXT DEFAULT 'unknown'"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE observations ADD COLUMN category TEXT DEFAULT 'note'"); } catch { /* column already exists */ }

  // Phase 4 — Learning Engine column migrations
  try { db.exec("ALTER TABLE lessons ADD COLUMN source TEXT DEFAULT 'manual'"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE lessons ADD COLUMN last_applied_at TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE lessons ADD COLUMN ignored_count INTEGER DEFAULT 0"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE rules ADD COLUMN auto_generated INTEGER DEFAULT 0"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE rules ADD COLUMN observance_score REAL DEFAULT NULL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE rules ADD COLUMN last_evaluated_at TEXT"); } catch { /* exists */ }

  // Phase 4 — Learning Engine new tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_patterns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      signature TEXT NOT NULL,
      description TEXT NOT NULL,
      frequency INTEGER DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      evidence TEXT NOT NULL,
      metadata TEXT,
      UNIQUE(project_id, signature)
    );

    CREATE TABLE IF NOT EXISTS context_feedback (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      context_id TEXT NOT NULL,
      context_type TEXT NOT NULL,
      was_useful INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0.5,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_rule_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      current_severity TEXT NOT NULL,
      proposed_severity TEXT NOT NULL,
      reason TEXT NOT NULL,
      observance_score REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS developer_profiles (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      session_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_scores (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      context_id TEXT NOT NULL,
      context_type TEXT NOT NULL,
      usefulness_score REAL NOT NULL DEFAULT 0.5,
      feedback_count INTEGER DEFAULT 0,
      last_updated_at TEXT NOT NULL,
      UNIQUE(project_id, context_id, context_type)
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_type_tool ON session_events(session_id, type, tool_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_project_ended ON sessions(project_id, ended_at);
    CREATE INDEX IF NOT EXISTS idx_learning_patterns_project ON learning_patterns(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_context_feedback_context ON context_feedback(project_id, context_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_project_status ON learning_rule_proposals(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_context_scores_project ON context_scores(project_id, context_type);
  `);

  // FTS5 tables for full-text search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, content, type,
        content='entities',
        content_rowid='rowid'
      );
    `);
  } catch {
    // FTS5 may already exist or not be available
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        content,
        content='observations',
        content_rowid='rowid'
      );
    `);
  } catch {
    // FTS5 may already exist or not be available
  }

  // FTS5 sync triggers for entities
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, content, type) VALUES (NEW.rowid, NEW.name, NEW.content, NEW.type);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, type) VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.type);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, type) VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.type);
        INSERT INTO entities_fts(rowid, name, content, type) VALUES (NEW.rowid, NEW.name, NEW.content, NEW.type);
      END;
    `);
  } catch {
    // triggers may already exist
  }

  // FTS5 sync triggers for observations
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_fts_insert AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_fts_delete AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_fts_update AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
        INSERT INTO observations_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);
  } catch {
    // triggers may already exist
  }

  // Handle embedding dimension changes
  const storedDimension = getStoredDimension(db);

  if (storedDimension !== null && storedDimension !== embeddingDimension) {
    console.error(
      `Warning: Embedding dimension changed from ${storedDimension} to ${embeddingDimension}. ` +
      `Dropping and recreating vec0 tables. Existing embeddings will be lost.`
    );
    recreateVecTables(db, embeddingDimension);
  } else {
    createVecTables(db, embeddingDimension);
  }

  setStoredDimension(db, embeddingDimension);

  return db;
}
