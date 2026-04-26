import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';

const DIM = 4;

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
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL, description TEXT, data TEXT NOT NULL,
      entity_count INTEGER, relation_count INTEGER, created_at TEXT NOT NULL
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
    CREATE VIRTUAL TABLE session_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE rule_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE lesson_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
  `);
  return db;
}

describe('Integration: Full "Second Brain" Workflow', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let vectorStore: VectorStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    vectorStore = new VectorStore(db);
    projectId = store.addProject({ name: 'MyApp', path: '/home/user/myapp' }).id;
  });

  afterEach(() => { db.close(); });

  it('should support a complete session workflow with events and counters', () => {
    const session = store.startSession({ projectId, goal: 'Implement auth module' });
    expect(session.goal).toBe('Implement auth module');

    store.addSessionEvent({ sessionId: session.id, type: 'tool_call', content: 'Read auth.ts', toolName: 'read_file' });
    store.updateSessionCounters(session.id, { toolCalls: 1 });

    store.addSessionEvent({ sessionId: session.id, type: 'decision', content: 'Use JWT over sessions' });
    store.addSessionEvent({ sessionId: session.id, type: 'discovery', content: 'Found deprecated bcrypt usage' });

    store.addEntity({ name: 'auth', type: 'module', projectId });
    store.updateSessionCounters(session.id, { entitiesModified: 1 });

    const ended = store.endSession(session.id, 'Auth module implemented with JWT');
    expect(ended.summary).toBe('Auth module implemented with JWT');
    expect(ended.endedAt).not.toBeNull();

    const final = store.getSession(session.id)!;
    expect(final.toolCalls).toBe(1);
    expect(final.entitiesModified).toBe(1);

    const events = store.getSessionEvents(session.id);
    expect(events.length).toBe(3);
    expect(events.map(e => e.type)).toEqual(['tool_call', 'decision', 'discovery']);
  });

  it('should support rules with matching and scoping', () => {
    store.addRule({ projectId, content: 'Use TypeScript strict mode', scope: 'global', severity: 'must' });
    store.addRule({ projectId, content: 'Components must be PascalCase', scope: 'file_pattern', pattern: 'src/components/*.tsx', severity: 'must' });
    store.addRule({ projectId, content: 'Use barrel exports', scope: 'file_pattern', pattern: 'src/*/index.ts', severity: 'should' });
    store.addRule({ projectId, content: 'Decisions must have rationale', scope: 'entity_type', pattern: 'decision', severity: 'must' });

    const componentRules = store.matchRules(projectId, { filePath: 'src/components/Header.tsx' });
    expect(componentRules.length).toBe(2);
    expect(componentRules.some(r => r.content.includes('PascalCase'))).toBe(true);
    expect(componentRules.some(r => r.content.includes('TypeScript strict'))).toBe(true);

    const decisionRules = store.matchRules(projectId, { entityType: 'decision' });
    expect(decisionRules.length).toBe(2);
    expect(decisionRules.some(r => r.content.includes('rationale'))).toBe(true);
  });

  it('should support learning with reinforcement loop', () => {
    const lesson = store.addLesson({
      projectId,
      trigger: 'Changing database schema',
      action: 'Run migration tests before commit',
      outcome: 'positive',
    });
    expect(lesson.confidence).toBe(0.5);

    store.reinforceLesson(lesson.id);
    store.reinforceLesson(lesson.id);
    store.reinforceLesson(lesson.id);

    const reinforced = store.getLesson(lesson.id)!;
    expect(reinforced.confidence).toBeCloseTo(0.8, 5);
    expect(reinforced.occurrences).toBe(4);

    store.addLesson({
      projectId,
      trigger: 'Touching auth module',
      action: 'Check token refresh logic',
      outcome: 'negative',
    });

    const positive = store.listLessons(projectId, { outcome: 'positive' });
    expect(positive.length).toBe(1);
    expect(positive[0].trigger).toBe('Changing database schema');

    const highConfidence = store.listLessons(projectId, { minConfidence: 0.7 });
    expect(highConfidence.length).toBe(1);
  });

  it('should create and retrieve snapshots with full graph data', () => {
    const auth = store.addEntity({ name: 'auth', type: 'module', projectId });
    const user = store.addEntity({ name: 'UserService', type: 'class', projectId });
    store.addRelation({ fromEntityId: auth.id, toEntityId: user.id, type: 'depends_on' });
    store.addObservation({ entityId: auth.id, content: 'Uses JWT' });
    store.addRule({ projectId, content: 'Always validate tokens' });
    store.addLesson({ projectId, trigger: 'Auth change', action: 'Run tests' });
    store.addIssue({ projectId, type: 'bug', title: 'Token leak' });

    const snap = store.createSnapshot(projectId, 'v1.0', 'First stable release');
    expect(snap.entityCount).toBe(2);
    expect(snap.relationCount).toBe(1);

    const data = JSON.parse(snap.data);
    expect(data.entities.length).toBe(2);
    expect(data.relations.length).toBe(1);
    expect(data.observations.length).toBe(1);
    expect(data.rules.length).toBe(1);
    expect(data.lessons.length).toBe(1);
    expect(data.issues.length).toBe(1);

    const list = store.listSnapshots(projectId);
    expect(list.length).toBe(1);
    expect(list[0].label).toBe('v1.0');
    expect((list[0] as Record<string, unknown>).data).toBeUndefined();

    store.deleteSnapshot(snap.id);
    expect(store.getSnapshot(snap.id)).toBeNull();
  });

  it('should link files to entities via relations', () => {
    store.upsertFileDigest({ projectId, path: 'src/auth.ts', summary: 'Auth module', language: 'typescript' });
    const authEntity = store.addEntity({ name: 'auth', type: 'module', projectId });

    const fileEntity = store.addEntity({
      name: 'file:src/auth.ts', type: 'file', projectId,
    });
    store.addRelation({ fromEntityId: authEntity.id, toEntityId: fileEntity.id, type: 'defined_in' });

    const relations = store.getRelations(authEntity.id, 'from');
    expect(relations.length).toBe(1);
    expect(relations[0].type).toBe('defined_in');
    expect(relations[0].toEntityId).toBe(fileEntity.id);
  });

  it('should track health metrics via getGraphSummary', () => {
    store.addEntity({ name: 'A', type: 'module', projectId });
    store.addEntity({ name: 'B', type: 'class', projectId });
    store.startSession({ projectId, goal: 'S1' });
    store.addRule({ projectId, content: 'R1' });
    store.addRule({ projectId, content: 'R2' });
    store.addLesson({ projectId, trigger: 'T', action: 'A' });
    store.addIssue({ projectId, type: 'bug', title: 'Bug' });
    store.upsertFileDigest({ projectId, path: 'a.ts' });

    const summary = store.getGraphSummary(projectId);
    expect(summary.entityCount).toBe(2);
    expect(summary.sessionCount).toBe(1);
    expect(summary.ruleCount).toBe(2);
    expect(summary.lessonCount).toBe(1);
    expect(summary.issueCount).toBe(1);
    expect(summary.openIssueCount).toBe(1);
    expect(summary.fileDigestCount).toBe(1);
  });

  it('should support vector search across sessions, rules, and lessons', () => {
    // Sessions
    const session = store.startSession({ projectId, goal: 'Auth work' });
    vectorStore.upsertSessionEmbedding(session.id, [1, 0, 0, 0]);

    const sessionResults = vectorStore.searchSessions([0.9, 0.1, 0, 0], 5);
    expect(sessionResults.length).toBe(1);
    expect(sessionResults[0].id).toBe(session.id);

    // Rules
    const rule = store.addRule({ projectId, content: 'Validate inputs' });
    vectorStore.upsertRuleEmbedding(rule.id, [0, 1, 0, 0]);

    const ruleResults = vectorStore.searchRules([0, 0.9, 0.1, 0], 5);
    expect(ruleResults.length).toBe(1);
    expect(ruleResults[0].id).toBe(rule.id);

    // Lessons
    const lesson = store.addLesson({ projectId, trigger: 'DB change', action: 'Run migrations' });
    vectorStore.upsertLessonEmbedding(lesson.id, [0, 0, 1, 0]);

    const lessonResults = vectorStore.searchLessons([0, 0, 0.9, 0.1], 5);
    expect(lessonResults.length).toBe(1);
    expect(lessonResults[0].id).toBe(lesson.id);
  });
});
