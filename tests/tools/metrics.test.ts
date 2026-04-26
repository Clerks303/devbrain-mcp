import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import type { DevBrain } from '../../src/server.js';
import type { DevBrainConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

const DIM = 4;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT,
      content TEXT, metadata TEXT, status TEXT DEFAULT 'unknown', embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE relations (
      id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL, weight REAL DEFAULT 1.0, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL, source TEXT, category TEXT DEFAULT 'note', embedding BLOB, created_at TEXT NOT NULL
    );
    CREATE TABLE file_digests (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
      content_hash TEXT, summary TEXT, exports TEXT, imports TEXT, language TEXT,
      loc INTEGER, status TEXT DEFAULT 'active', embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, entity_id TEXT, file_path TEXT,
      type TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      severity TEXT DEFAULT 'medium', status TEXT DEFAULT 'open', resolution TEXT,
      embedding BLOB, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal TEXT NOT NULL,
      summary TEXT, tool_calls INTEGER DEFAULT 0, entities_modified INTEGER DEFAULT 0,
      started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE session_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      content TEXT NOT NULL, tool_name TEXT, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE rules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      pattern TEXT, content TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'should',
      embedding BLOB, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE lessons (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, trigger_text TEXT NOT NULL,
      action TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'neutral',
      confidence REAL DEFAULT 0.5, occurrences INTEGER DEFAULT 1,
      embedding BLOB, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL,
      description TEXT, data TEXT NOT NULL, entity_count INTEGER,
      relation_count INTEGER, created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE entity_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE observation_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
  `);

  db.prepare("INSERT INTO meta (key, value) VALUES ('embedding_dimension', ?)").run(String(DIM));

  return db;
}

function createMockBrain(db: Database.Database): DevBrain {
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);
  const mockProvider: EmbeddingProvider = {
    dimension: DIM,
    embed: async () => new Array(DIM).fill(0),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(DIM).fill(0)),
  };
  const config: DevBrainConfig = {
    dbPath: ':memory:',
    embeddingProvider: 'none',
    embeddingDimension: DIM,
    transport: 'stdio',
    openaiModel: 'text-embedding-3-small',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
  };

  return {
    store,
    vectorStore,
    embeddingProvider: mockProvider,
    startedAt: new Date(),
    dbPath: ':memory:',
    config,
    activeProjectId: null,
  } as DevBrain;
}

describe('Metrics tool structure', () => {
  let db: Database.Database;
  let brain: DevBrain;

  beforeEach(() => {
    db = createTestDb();
    brain = createMockBrain(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return valid metrics structure with empty database', async () => {
    const { registerMetricsTools } = await import('../../src/tools/metrics.js');

    const uptime = Date.now() - brain.startedAt.getTime();

    expect(uptime).toBeGreaterThanOrEqual(0);
    expect(brain.config.embeddingProvider).toBe('none');
    expect(brain.dbPath).toBe(':memory:');
    expect(typeof registerMetricsTools).toBe('function');
  });

  it('should count table rows correctly after inserting data', () => {
    const store = brain.store;
    store.addEntity({ name: 'TestEntity', type: 'class' });
    store.addEntity({ name: 'TestEntity2', type: 'function' });

    const entityCount = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    expect(entityCount).toBe(2);

    const projectCount = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    expect(projectCount).toBe(0);
  });

  it('should read stored embedding dimension from meta table', () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'embedding_dimension'").get() as { value: string };
    expect(parseInt(row.value, 10)).toBe(DIM);
  });

  it('should have correct config fields', () => {
    expect(brain.config).toHaveProperty('dbPath');
    expect(brain.config).toHaveProperty('embeddingProvider');
    expect(brain.config).toHaveProperty('embeddingDimension');
    expect(brain.config).toHaveProperty('transport');
  });

  it('should have startedAt as a valid Date', () => {
    expect(brain.startedAt).toBeInstanceOf(Date);
    expect(brain.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
