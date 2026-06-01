import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';

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
  `);

  return db;
}

describe('KnowledgeStore — Sessions', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    projectId = store.addProject({ name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => { db.close(); });

  it('should start and retrieve a session', () => {
    const session = store.startSession({ projectId, goal: 'Fix auth bug' });
    expect(session.id).toBeDefined();
    expect(session.goal).toBe('Fix auth bug');
    expect(session.projectId).toBe(projectId);
    expect(session.toolCalls).toBe(0);
    expect(session.entitiesModified).toBe(0);
    expect(session.endedAt).toBeNull();

    const retrieved = store.getSession(session.id);
    expect(retrieved).toEqual(session);
  });

  it('should end a session with summary', () => {
    const session = store.startSession({ projectId, goal: 'Refactor DB' });
    const ended = store.endSession(session.id, 'Refactored 3 modules');
    expect(ended.endedAt).not.toBeNull();
    expect(ended.summary).toBe('Refactored 3 modules');
  });

  it('should end a session without summary', () => {
    const session = store.startSession({ projectId, goal: 'Quick fix' });
    const ended = store.endSession(session.id);
    expect(ended.endedAt).not.toBeNull();
    expect(ended.summary).toBeNull();
  });

  it('should update session counters', () => {
    const session = store.startSession({ projectId, goal: 'Work' });
    store.updateSessionCounters(session.id, { toolCalls: 3 });
    store.updateSessionCounters(session.id, { entitiesModified: 2 });
    store.updateSessionCounters(session.id, { toolCalls: 1, entitiesModified: 1 });

    const updated = store.getSession(session.id)!;
    expect(updated.toolCalls).toBe(4);
    expect(updated.entitiesModified).toBe(3);
  });

  it('should add and retrieve session events', () => {
    const session = store.startSession({ projectId, goal: 'Work' });

    const e1 = store.addSessionEvent({
      sessionId: session.id, type: 'tool_call',
      content: 'Called devbrain_search', toolName: 'devbrain_search',
    });
    const e2 = store.addSessionEvent({
      sessionId: session.id, type: 'decision',
      content: 'Decided to use JWT',
    });
    const e3 = store.addSessionEvent({
      sessionId: session.id, type: 'error',
      content: 'Type error in auth module',
      metadata: { file: 'auth.ts', line: 42 },
    });

    expect(e1.type).toBe('tool_call');
    expect(e1.toolName).toBe('devbrain_search');
    expect(e2.toolName).toBeNull();
    expect(e3.metadata).toEqual({ file: 'auth.ts', line: 42 });

    const events = store.getSessionEvents(session.id);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('tool_call');
    expect(events[2].type).toBe('error');
  });

  it('should list all sessions for a project', () => {
    store.startSession({ projectId, goal: 'First' });
    store.startSession({ projectId, goal: 'Second' });
    store.startSession({ projectId, goal: 'Third' });

    const sessions = store.listSessions(projectId);
    expect(sessions.length).toBe(3);
    const goals = sessions.map(s => s.goal).sort();
    expect(goals).toEqual(['First', 'Second', 'Third']);
  });

  it('should respect limit in listSessions', () => {
    store.startSession({ projectId, goal: 'A' });
    store.startSession({ projectId, goal: 'B' });
    store.startSession({ projectId, goal: 'C' });

    const sessions = store.listSessions(projectId, 2);
    expect(sessions.length).toBe(2);
  });

  it('should get the last ended session (not a running one)', () => {
    const s1 = store.startSession({ projectId, goal: 'First' });
    store.endSession(s1.id, 'Done 1');
    store.startSession({ projectId, goal: 'Still running' });

    const last = store.getLastSession(projectId);
    expect(last).not.toBeNull();
    expect(last!.goal).toBe('First');
    expect(last!.summary).toBe('Done 1');
    expect(last!.endedAt).not.toBeNull();
  });

  it('should return null for getLastSession with no ended sessions', () => {
    store.startSession({ projectId, goal: 'Still running' });
    expect(store.getLastSession(projectId)).toBeNull();
  });

  it('should cascade delete events when session is deleted', () => {
    const session = store.startSession({ projectId, goal: 'Work' });
    store.addSessionEvent({ sessionId: session.id, type: 'tool_call', content: 'test' });
    store.addSessionEvent({ sessionId: session.id, type: 'decision', content: 'test2' });

    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    const events = store.getSessionEvents(session.id);
    expect(events.length).toBe(0);
  });
});

describe('KnowledgeStore — Rules', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    projectId = store.addProject({ name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => { db.close(); });

  it('should add and retrieve a rule', () => {
    const rule = store.addRule({ projectId, content: 'Always use strict TypeScript' });
    expect(rule.id).toBeDefined();
    expect(rule.content).toBe('Always use strict TypeScript');
    expect(rule.scope).toBe('global');
    expect(rule.severity).toBe('should');
    expect(rule.pattern).toBeNull();

    const retrieved = store.getRule(rule.id);
    expect(retrieved).toEqual(rule);
  });

  it('should add a rule with all fields', () => {
    const rule = store.addRule({
      projectId, content: 'Use PascalCase for components',
      scope: 'file_pattern', pattern: 'src/components/*.tsx',
      severity: 'must', metadata: { author: 'romain' },
    });
    expect(rule.scope).toBe('file_pattern');
    expect(rule.pattern).toBe('src/components/*.tsx');
    expect(rule.severity).toBe('must');
    expect(rule.metadata).toEqual({ author: 'romain' });
  });

  it('should update a rule', () => {
    const rule = store.addRule({ projectId, content: 'Old rule' });
    const updated = store.updateRule(rule.id, {
      content: 'New rule', severity: 'must', scope: 'entity_type', pattern: 'class',
    });
    expect(updated.content).toBe('New rule');
    expect(updated.severity).toBe('must');
    expect(updated.scope).toBe('entity_type');
    expect(updated.pattern).toBe('class');
    // updatedAt may match if same millisecond, just verify the update was applied
    expect(updated.id).toBe(rule.id);
  });

  it('should throw when updating non-existent rule', () => {
    expect(() => store.updateRule('nonexistent', { content: 'x' })).toThrow('Rule not found');
  });

  it('should list rules sorted by severity then date', () => {
    store.addRule({ projectId, content: 'Should rule', severity: 'should' });
    store.addRule({ projectId, content: 'Must rule', severity: 'must' });
    store.addRule({ projectId, content: 'Prefer rule', severity: 'prefer' });

    const rules = store.listRules(projectId);
    expect(rules.length).toBe(3);
    // ORDER BY severity ASC: must < prefer < should (alphabetical)
    expect(rules[0].severity).toBe('must');
    expect(rules[1].severity).toBe('prefer');
    expect(rules[2].severity).toBe('should');
  });

  it('should filter rules by scope', () => {
    store.addRule({ projectId, content: 'Global', scope: 'global' });
    store.addRule({ projectId, content: 'File', scope: 'file_pattern', pattern: '*.ts' });
    store.addRule({ projectId, content: 'Entity', scope: 'entity_type', pattern: 'class' });

    const globalRules = store.listRules(projectId, 'global');
    expect(globalRules.length).toBe(1);
    expect(globalRules[0].content).toBe('Global');

    const fileRules = store.listRules(projectId, 'file_pattern');
    expect(fileRules.length).toBe(1);
    expect(fileRules[0].content).toBe('File');
  });

  it('should match global rules always', () => {
    store.addRule({ projectId, content: 'Global rule' });
    const matched = store.matchRules(projectId, {});
    expect(matched.length).toBe(1);
  });

  it('should match file_pattern rules with glob', () => {
    store.addRule({ projectId, content: 'TS rule', scope: 'file_pattern', pattern: 'src/*.ts' });
    store.addRule({ projectId, content: 'JSX rule', scope: 'file_pattern', pattern: 'src/*.tsx' });

    const tsMatch = store.matchRules(projectId, { filePath: 'src/index.ts' });
    expect(tsMatch.some(r => r.content === 'TS rule')).toBe(true);
    expect(tsMatch.some(r => r.content === 'JSX rule')).toBe(false);

    const tsxMatch = store.matchRules(projectId, { filePath: 'src/App.tsx' });
    expect(tsxMatch.some(r => r.content === 'JSX rule')).toBe(true);
  });

  it('should match entity_type rules by exact type', () => {
    store.addRule({ projectId, content: 'Class rule', scope: 'entity_type', pattern: 'class' });
    store.addRule({ projectId, content: 'Module rule', scope: 'entity_type', pattern: 'module' });

    const classMatch = store.matchRules(projectId, { entityType: 'class' });
    expect(classMatch.some(r => r.content === 'Class rule')).toBe(true);
    expect(classMatch.some(r => r.content === 'Module rule')).toBe(false);
  });

  it('should delete a rule', () => {
    const rule = store.addRule({ projectId, content: 'To delete' });
    store.deleteRule(rule.id);
    expect(store.getRule(rule.id)).toBeNull();
  });
});

describe('KnowledgeStore — Lessons', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    projectId = store.addProject({ name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => { db.close(); });

  it('should add and retrieve a lesson', () => {
    const lesson = store.addLesson({
      projectId,
      trigger: 'Modifying auth module',
      action: 'Always check token expiry',
      outcome: 'positive',
    });
    expect(lesson.id).toBeDefined();
    expect(lesson.trigger).toBe('Modifying auth module');
    expect(lesson.action).toBe('Always check token expiry');
    expect(lesson.outcome).toBe('positive');
    expect(lesson.confidence).toBe(0.5);
    expect(lesson.occurrences).toBe(1);

    const retrieved = store.getLesson(lesson.id);
    expect(retrieved).toEqual(lesson);
  });

  it('should add lesson with defaults', () => {
    const lesson = store.addLesson({ projectId, trigger: 'T', action: 'A' });
    expect(lesson.outcome).toBe('neutral');
    expect(lesson.confidence).toBe(0.5);
    expect(lesson.occurrences).toBe(1);
  });

  it('should reinforce a lesson', () => {
    const lesson = store.addLesson({ projectId, trigger: 'T', action: 'A' });
    expect(lesson.confidence).toBe(0.5);
    expect(lesson.occurrences).toBe(1);

    const r1 = store.reinforceLesson(lesson.id);
    expect(r1.confidence).toBeCloseTo(0.6, 5);
    expect(r1.occurrences).toBe(2);

    const r2 = store.reinforceLesson(lesson.id);
    expect(r2.confidence).toBeCloseTo(0.7, 5);
    expect(r2.occurrences).toBe(3);
  });

  it('should cap confidence at 1.0', () => {
    const lesson = store.addLesson({ projectId, trigger: 'T', action: 'A' });
    for (let i = 0; i < 6; i++) store.reinforceLesson(lesson.id);
    const final = store.getLesson(lesson.id)!;
    expect(final.confidence).toBe(1.0);
    expect(final.occurrences).toBe(7);
  });

  it('should throw when reinforcing non-existent lesson', () => {
    expect(() => store.reinforceLesson('nonexistent')).toThrow('Lesson not found');
  });

  it('should list lessons sorted by confidence', () => {
    store.addLesson({ projectId, trigger: 'Low', action: 'A' });
    const l2 = store.addLesson({ projectId, trigger: 'High', action: 'B' });
    store.reinforceLesson(l2.id);
    store.reinforceLesson(l2.id);

    const lessons = store.listLessons(projectId);
    expect(lessons.length).toBe(2);
    expect(lessons[0].trigger).toBe('High');
    expect(lessons[1].trigger).toBe('Low');
  });

  it('should filter lessons by outcome', () => {
    store.addLesson({ projectId, trigger: 'T1', action: 'A1', outcome: 'positive' });
    store.addLesson({ projectId, trigger: 'T2', action: 'A2', outcome: 'negative' });
    store.addLesson({ projectId, trigger: 'T3', action: 'A3', outcome: 'positive' });

    const positive = store.listLessons(projectId, { outcome: 'positive' });
    expect(positive.length).toBe(2);

    const negative = store.listLessons(projectId, { outcome: 'negative' });
    expect(negative.length).toBe(1);
  });

  it('should filter lessons by minimum confidence', () => {
    store.addLesson({ projectId, trigger: 'T1', action: 'A1' });
    const l2 = store.addLesson({ projectId, trigger: 'T2', action: 'A2' });
    store.reinforceLesson(l2.id);
    store.reinforceLesson(l2.id);

    const highConf = store.listLessons(projectId, { minConfidence: 0.65 });
    expect(highConf.length).toBe(1);
    expect(highConf[0].trigger).toBe('T2');
  });

  it('should delete a lesson', () => {
    const lesson = store.addLesson({ projectId, trigger: 'T', action: 'A' });
    store.deleteLesson(lesson.id);
    expect(store.getLesson(lesson.id)).toBeNull();
  });
});

describe('KnowledgeStore — Snapshots', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    projectId = store.addProject({ name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => { db.close(); });

  it('should create a snapshot with graph data', () => {
    const e1 = store.addEntity({ name: 'A', type: 'module', projectId });
    const e2 = store.addEntity({ name: 'B', type: 'class', projectId });
    store.addRelation({ fromEntityId: e1.id, toEntityId: e2.id, type: 'imports' });
    store.addObservation({ entityId: e1.id, content: 'Important module' });

    const snapshot = store.createSnapshot(projectId, 'v1.0', 'First release');
    expect(snapshot.id).toBeDefined();
    expect(snapshot.label).toBe('v1.0');
    expect(snapshot.description).toBe('First release');
    expect(snapshot.entityCount).toBe(2);
    expect(snapshot.relationCount).toBe(1);

    const data = JSON.parse(snapshot.data);
    expect(data.entities.length).toBe(2);
    expect(data.relations.length).toBe(1);
    expect(data.observations.length).toBe(1);
  });

  it('should create snapshot without description', () => {
    const snapshot = store.createSnapshot(projectId, 'empty');
    expect(snapshot.description).toBeNull();
    expect(snapshot.entityCount).toBe(0);
  });

  it('should include rules and lessons in snapshot', () => {
    store.addRule({ projectId, content: 'Use strict' });
    store.addLesson({ projectId, trigger: 'T', action: 'A' });

    const snapshot = store.createSnapshot(projectId, 'with-extras');
    const data = JSON.parse(snapshot.data);
    expect(data.rules.length).toBe(1);
    expect(data.lessons.length).toBe(1);
  });

  it('should list snapshots without data', () => {
    store.createSnapshot(projectId, 'snap1');
    store.createSnapshot(projectId, 'snap2');

    const list = store.listSnapshots(projectId);
    expect(list.length).toBe(2);
    const labels = list.map(s => s.label).sort();
    expect(labels).toEqual(['snap1', 'snap2']);
    // listSnapshots omits data field
    expect((list[0] as Record<string, unknown>).data).toBeUndefined();
  });

  it('should get a snapshot with full data', () => {
    store.addEntity({ name: 'X', type: 'class', projectId });
    const created = store.createSnapshot(projectId, 'full');
    const retrieved = store.getSnapshot(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.data).toBeDefined();
    const data = JSON.parse(retrieved!.data);
    expect(data.entities.length).toBe(1);
  });

  it('should return null for non-existent snapshot', () => {
    expect(store.getSnapshot('nonexistent')).toBeNull();
  });

  it('should delete a snapshot', () => {
    const snapshot = store.createSnapshot(projectId, 'to-delete');
    store.deleteSnapshot(snapshot.id);
    expect(store.getSnapshot(snapshot.id)).toBeNull();
  });
});

describe('KnowledgeStore — getGraphSummary with new counts', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    projectId = store.addProject({ name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => { db.close(); });

  it('should include sessionCount, ruleCount, lessonCount', () => {
    store.startSession({ projectId, goal: 'S1' });
    store.startSession({ projectId, goal: 'S2' });
    store.addRule({ projectId, content: 'R1' });
    store.addRule({ projectId, content: 'R2' });
    store.addRule({ projectId, content: 'R3' });
    store.addLesson({ projectId, trigger: 'T', action: 'A' });

    const summary = store.getGraphSummary(projectId);
    expect(summary.sessionCount).toBe(2);
    expect(summary.ruleCount).toBe(3);
    expect(summary.lessonCount).toBe(1);
  });

  it('should return 0 counts when empty', () => {
    const summary = store.getGraphSummary(projectId);
    expect(summary.sessionCount).toBe(0);
    expect(summary.ruleCount).toBe(0);
    expect(summary.lessonCount).toBe(0);
  });
});

describe('KnowledgeStore — getDb accessor', () => {
  it('should return the underlying database', () => {
    const db = new Database(':memory:');
    const store = new KnowledgeStore(db);
    expect(store.getDb()).toBe(db);
    db.close();
  });
});
