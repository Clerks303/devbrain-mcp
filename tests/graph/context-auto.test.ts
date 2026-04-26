import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';
import { getAutoContext } from '../../src/graph/context-auto.js';

const DIM = 4;

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = DIM;
  async embed(text: string): Promise<number[]> {
    const code = text.charCodeAt(0) / 255;
    return [code, 1 - code, 0.5, 0.5];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT,
      content TEXT, metadata TEXT, status TEXT DEFAULT 'unknown', embedding BLOB,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL, content_hash TEXT, summary TEXT, exports TEXT, imports TEXT,
      language TEXT, loc INTEGER, status TEXT DEFAULT 'active', embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_file_digests_project_path ON file_digests(project_id, path);
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_id TEXT, file_path TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, severity TEXT DEFAULT 'medium', status TEXT DEFAULT 'open',
      resolution TEXT, embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal TEXT NOT NULL, summary TEXT, tool_calls INTEGER DEFAULT 0,
      entities_modified INTEGER DEFAULT 0, started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT,
      metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'global', pattern TEXT, content TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'should', embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE lessons (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      trigger_text TEXT NOT NULL, action TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'neutral', confidence REAL DEFAULT 0.5,
      occurrences INTEGER DEFAULT 1, embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE entity_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE observation_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE file_digest_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE issue_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE rule_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE lesson_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE session_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
  `);
  return db;
}

describe('getAutoContext', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let vectorStore: VectorStore;
  let embeddingProvider: FakeEmbeddingProvider;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    vectorStore = new VectorStore(db);
    embeddingProvider = new FakeEmbeddingProvider();
    projectId = store.addProject({ name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => { db.close(); });

  it('should return empty results for empty project', async () => {
    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'auth module',
    });

    expect(result.entities).toEqual([]);
    expect(result.rules).toEqual([]);
    expect(result.lessons).toEqual([]);
    expect(result.openIssues).toEqual([]);
    expect(result.lastSession).toBeNull();
  });

  it('should return entities from hybrid search', async () => {
    const entity = store.addEntity({ name: 'AuthModule', type: 'module', projectId, content: 'Auth' });
    const embedding = await embeddingProvider.embed('AuthModule: Auth');
    vectorStore.upsertEntityEmbedding(entity.id, embedding);

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'auth module',
    });

    expect(result.entities.length).toBeGreaterThan(0);
  });

  it('should return matching rules', async () => {
    store.addRule({ projectId, content: 'Always validate JWT tokens', scope: 'global' });
    store.addRule({ projectId, content: 'Use camelCase', scope: 'file_pattern', pattern: 'src/*.ts' });

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'authentication',
      filePath: 'src/auth.ts',
    });

    expect(result.rules.length).toBe(2);
  });

  it('should return only global rules when no file path provided', async () => {
    store.addRule({ projectId, content: 'Global rule', scope: 'global' });
    store.addRule({ projectId, content: 'File rule', scope: 'file_pattern', pattern: 'src/*.ts' });

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'something',
    });

    const globalRules = result.rules.filter(r => r.scope === 'global');
    expect(globalRules.length).toBe(1);
  });

  it('should return open issues', async () => {
    store.addIssue({ projectId, type: 'bug', title: 'Auth fails on expired tokens' });
    store.addIssue({ projectId, type: 'bug', title: 'Login broken' });
    const resolved = store.addIssue({ projectId, type: 'bug', title: 'Fixed issue' });
    store.updateIssue(resolved.id, { status: 'resolved' });

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'auth',
    });

    expect(result.openIssues.length).toBe(2);
    expect(result.openIssues.every(i => i.status === 'open')).toBe(true);
  });

  it('should return last ended session', async () => {
    const s1 = store.startSession({ projectId, goal: 'Only session' });
    store.endSession(s1.id, 'Done');

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'anything',
    });

    expect(result.lastSession).not.toBeNull();
    expect(result.lastSession!.goal).toBe('Only session');
    expect(result.lastSession!.summary).toBe('Done');
  });

  it('should respect includeRules=false', async () => {
    store.addRule({ projectId, content: 'A rule' });

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'test',
      includeRules: false,
    });

    expect(result.rules).toEqual([]);
  });

  it('should respect includeLessons=false', async () => {
    store.addLesson({ projectId, trigger: 'T', action: 'A' });

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'test',
      includeLessons: false,
    });

    expect(result.lessons).toEqual([]);
  });

  it('should respect includeIssues=false', async () => {
    store.addIssue({ projectId, type: 'bug', title: 'A bug' });

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'test',
      includeIssues: false,
    });

    expect(result.openIssues).toEqual([]);
  });

  it('should limit open issues to 5', async () => {
    for (let i = 0; i < 8; i++) {
      store.addIssue({ projectId, type: 'bug', title: `Bug ${i}` });
    }

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'bugs',
    });

    expect(result.openIssues.length).toBe(5);
  });

  it('should return lessons found by semantic search', async () => {
    const lesson = store.addLesson({ projectId, trigger: 'Auth refactoring', action: 'Check tokens' });
    const embedding = await embeddingProvider.embed('Auth refactoring: Check tokens');
    vectorStore.upsertLessonEmbedding(lesson.id, embedding);

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'Auth refactoring: Check tokens',
    });

    expect(result.lessons.length).toBeGreaterThan(0);
    expect(result.lessons[0].trigger).toBe('Auth refactoring');
  });

  it('should aggregate all sources in one call', async () => {
    const entity = store.addEntity({ name: 'Auth', type: 'module', projectId, content: 'Authentication' });
    const embedding = await embeddingProvider.embed('Auth: Authentication');
    vectorStore.upsertEntityEmbedding(entity.id, embedding);

    store.addRule({ projectId, content: 'Validate tokens' });
    store.addIssue({ projectId, type: 'bug', title: 'Token expiry bug' });

    const lesson = store.addLesson({ projectId, trigger: 'auth changes', action: 'run tests' });
    const lessonEmb = await embeddingProvider.embed('auth changes: run tests');
    vectorStore.upsertLessonEmbedding(lesson.id, lessonEmb);

    const session = store.startSession({ projectId, goal: 'Fix auth' });
    store.endSession(session.id, 'Fixed');

    const result = await getAutoContext(store, vectorStore, embeddingProvider, projectId, {
      query: 'auth module',
    });

    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.openIssues.length).toBe(1);
    expect(result.lastSession).not.toBeNull();
  });
});
