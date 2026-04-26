import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
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
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal TEXT NOT NULL, summary TEXT, tool_calls INTEGER DEFAULT 0,
      entities_modified INTEGER DEFAULT 0, started_at TEXT NOT NULL, ended_at TEXT
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

function randomVector(): number[] {
  const v = Array.from({ length: DIM }, () => Math.random());
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map(x => x / norm);
}

function insertSession(db: Database.Database, projectId: string, id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, goal, started_at)
    VALUES (?, ?, 'test goal', datetime('now'))
  `).run(id, projectId);
}

function insertRule(db: Database.Database, projectId: string, id: string): void {
  db.prepare(`
    INSERT INTO rules (id, project_id, content, created_at, updated_at)
    VALUES (?, ?, 'test rule', datetime('now'), datetime('now'))
  `).run(id, projectId);
}

function insertLesson(db: Database.Database, projectId: string, id: string): void {
  db.prepare(`
    INSERT INTO lessons (id, project_id, trigger_text, action, created_at, updated_at)
    VALUES (?, ?, 'test trigger', 'test action', datetime('now'), datetime('now'))
  `).run(id, projectId);
}

describe('VectorStore — Session Embeddings', () => {
  let db: Database.Database;
  let vectorStore: VectorStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    vectorStore = new VectorStore(db);
    projectId = 'proj-1';
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Test', datetime('now'))").run(projectId);
  });

  afterEach(() => { db.close(); });

  it('should upsert and search session embeddings', () => {
    insertSession(db, projectId, 'session-1');
    const embedding = randomVector();
    vectorStore.upsertSessionEmbedding('session-1', embedding);

    const results = vectorStore.searchSessions(embedding, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('session-1');
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('should find similar sessions', () => {
    insertSession(db, projectId, 's1');
    insertSession(db, projectId, 's2');
    insertSession(db, projectId, 's3');

    vectorStore.upsertSessionEmbedding('s1', [1, 0, 0, 0]);
    vectorStore.upsertSessionEmbedding('s2', [0.9, 0.1, 0, 0]);
    vectorStore.upsertSessionEmbedding('s3', [0, 0, 0, 1]);

    const results = vectorStore.searchSessions([1, 0, 0, 0], 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe('s1');
    expect(results[1].id).toBe('s2');
  });

  it('should replace embedding on upsert', () => {
    insertSession(db, projectId, 's1');
    vectorStore.upsertSessionEmbedding('s1', [1, 0, 0, 0]);
    vectorStore.upsertSessionEmbedding('s1', [0, 1, 0, 0]);

    const results = vectorStore.searchSessions([0, 1, 0, 0], 5);
    expect(results.length).toBe(1);
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('should delete session embedding', () => {
    insertSession(db, projectId, 's1');
    vectorStore.upsertSessionEmbedding('s1', randomVector());
    vectorStore.deleteSessionEmbedding('s1');

    const results = vectorStore.searchSessions(randomVector(), 5);
    expect(results.length).toBe(0);
  });
});

describe('VectorStore — Rule Embeddings', () => {
  let db: Database.Database;
  let vectorStore: VectorStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    vectorStore = new VectorStore(db);
    projectId = 'proj-1';
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Test', datetime('now'))").run(projectId);
  });

  afterEach(() => { db.close(); });

  it('should upsert and search rule embeddings', () => {
    insertRule(db, projectId, 'rule-1');
    const embedding = randomVector();
    vectorStore.upsertRuleEmbedding('rule-1', embedding);

    const results = vectorStore.searchRules(embedding, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('rule-1');
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('should not write duplicate embedding blob to rules table', () => {
    insertRule(db, projectId, 'rule-1');
    vectorStore.upsertRuleEmbedding('rule-1', [1, 0, 0, 0]);

    const row = db.prepare('SELECT embedding FROM rules WHERE id = ?').get('rule-1') as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });

  it('should find similar rules', () => {
    insertRule(db, projectId, 'r1');
    insertRule(db, projectId, 'r2');

    vectorStore.upsertRuleEmbedding('r1', [1, 0, 0, 0]);
    vectorStore.upsertRuleEmbedding('r2', [0, 0, 0, 1]);

    const results = vectorStore.searchRules([0.9, 0.1, 0, 0], 2);
    expect(results[0].id).toBe('r1');
  });

  it('should delete rule embedding', () => {
    insertRule(db, projectId, 'r1');
    vectorStore.upsertRuleEmbedding('r1', randomVector());
    vectorStore.deleteRuleEmbedding('r1');

    const results = vectorStore.searchRules(randomVector(), 5);
    expect(results.length).toBe(0);
  });
});

describe('VectorStore — Lesson Embeddings', () => {
  let db: Database.Database;
  let vectorStore: VectorStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    vectorStore = new VectorStore(db);
    projectId = 'proj-1';
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Test', datetime('now'))").run(projectId);
  });

  afterEach(() => { db.close(); });

  it('should upsert and search lesson embeddings', () => {
    insertLesson(db, projectId, 'lesson-1');
    const embedding = randomVector();
    vectorStore.upsertLessonEmbedding('lesson-1', embedding);

    const results = vectorStore.searchLessons(embedding, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('lesson-1');
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('should not write duplicate embedding blob to lessons table', () => {
    insertLesson(db, projectId, 'lesson-1');
    vectorStore.upsertLessonEmbedding('lesson-1', [0, 1, 0, 0]);

    const row = db.prepare('SELECT embedding FROM lessons WHERE id = ?').get('lesson-1') as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });

  it('should find similar lessons', () => {
    insertLesson(db, projectId, 'l1');
    insertLesson(db, projectId, 'l2');
    insertLesson(db, projectId, 'l3');

    vectorStore.upsertLessonEmbedding('l1', [1, 0, 0, 0]);
    vectorStore.upsertLessonEmbedding('l2', [0.8, 0.2, 0, 0]);
    vectorStore.upsertLessonEmbedding('l3', [0, 0, 1, 0]);

    const results = vectorStore.searchLessons([1, 0, 0, 0], 3);
    expect(results[0].id).toBe('l1');
    expect(results[1].id).toBe('l2');
  });

  it('should delete lesson embedding', () => {
    insertLesson(db, projectId, 'l1');
    vectorStore.upsertLessonEmbedding('l1', randomVector());
    vectorStore.deleteLessonEmbedding('l1');

    const results = vectorStore.searchLessons(randomVector(), 5);
    expect(results.length).toBe(0);
  });
});
