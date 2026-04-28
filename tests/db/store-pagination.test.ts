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
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL, content_hash TEXT, summary TEXT, exports TEXT, imports TEXT,
      language TEXT, loc INTEGER, status TEXT DEFAULT 'active', embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_file_digests_project_path ON file_digests(project_id, path);
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_id TEXT, file_path TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, severity TEXT DEFAULT 'medium', status TEXT DEFAULT 'open',
      resolution TEXT, embedding BLOB, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal TEXT NOT NULL, summary TEXT, tool_calls INTEGER DEFAULT 0,
      entities_modified INTEGER DEFAULT 0, started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE session_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE rules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'global', pattern TEXT, content TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'should', embedding BLOB, metadata TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE lessons (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      trigger_text TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'neutral',
      confidence REAL DEFAULT 0.5, occurrences INTEGER DEFAULT 1, embedding BLOB,
      metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL, description TEXT, data TEXT NOT NULL,
      entity_count INTEGER, relation_count INTEGER, created_at TEXT NOT NULL
    );
  `);

  return db;
}

describe('KnowledgeStore - Pagination', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    const project = store.addProject({ name: 'TestProject', path: '/test' });
    projectId = project.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('listEntities pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 15; i++) {
        store.addEntity({ name: `Entity${i}`, type: 'class', projectId });
      }
    });

    it('should return default limit of 100 (all items when < 100)', () => {
      const results = store.listEntities(projectId);
      expect(results.length).toBe(15);
    });

    it('should respect limit parameter', () => {
      const results = store.listEntities(projectId, undefined, 5);
      expect(results.length).toBe(5);
    });

    it('should respect offset parameter', () => {
      const all = store.listEntities(projectId, undefined, 100, 0);
      const offset5 = store.listEntities(projectId, undefined, 100, 5);

      expect(offset5.length).toBe(10);
      expect(offset5[0].id).toBe(all[5].id);
    });

    it('should handle limit + offset together', () => {
      const page1 = store.listEntities(projectId, undefined, 5, 0);
      const page2 = store.listEntities(projectId, undefined, 5, 5);
      const page3 = store.listEntities(projectId, undefined, 5, 10);
      const page4 = store.listEntities(projectId, undefined, 5, 15);

      expect(page1.length).toBe(5);
      expect(page2.length).toBe(5);
      expect(page3.length).toBe(5);
      expect(page4.length).toBe(0);

      // All IDs should be unique across pages
      const allIds = [...page1, ...page2, ...page3].map(e => e.id);
      expect(new Set(allIds).size).toBe(15);
    });

    it('should return empty array for offset beyond total', () => {
      const results = store.listEntities(projectId, undefined, 100, 100);
      expect(results.length).toBe(0);
    });
  });

  describe('listProjects pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        store.addProject({ name: `Project${i}`, path: `/path/${i}` });
      }
    });

    it('should respect limit and offset', () => {
      // +1 for the project created in the outer beforeEach
      const all = store.listProjects(100, 0);
      expect(all.length).toBe(6);

      const limited = store.listProjects(3, 0);
      expect(limited.length).toBe(3);

      const offset = store.listProjects(3, 3);
      expect(offset.length).toBe(3);
    });
  });

  describe('listIssues pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        store.addIssue({ projectId, type: 'bug', title: `Issue ${i}` });
      }
    });

    it('should respect limit and offset', () => {
      const page1 = store.listIssues(projectId, { limit: 3, offset: 0 });
      const page2 = store.listIssues(projectId, { limit: 3, offset: 3 });

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('should combine filters with pagination', () => {
      store.addIssue({ projectId, type: 'debt', title: 'Debt issue' });

      const bugs = store.listIssues(projectId, { type: 'bug', limit: 5, offset: 0 });
      expect(bugs.length).toBe(5);
      expect(bugs.every(i => i.type === 'bug')).toBe(true);
    });
  });

  describe('listSessions pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 8; i++) {
        store.startSession({ projectId, goal: `Session goal ${i}` });
      }
    });

    it('should respect limit and offset', () => {
      const page1 = store.listSessions(projectId, 3, 0);
      const page2 = store.listSessions(projectId, 3, 3);

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('should default limit to 100', () => {
      const all = store.listSessions(projectId);
      expect(all.length).toBe(8);
    });
  });

  describe('listRules pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 7; i++) {
        store.addRule({ projectId, content: `Rule ${i}` });
      }
    });

    it('should respect limit and offset', () => {
      const page1 = store.listRules(projectId, undefined, 3, 0);
      const page2 = store.listRules(projectId, undefined, 3, 3);

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
    });
  });

  describe('listLessons pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 6; i++) {
        store.addLesson({ projectId, trigger: `Trigger ${i}`, action: `Action ${i}` });
      }
    });

    it('should respect limit and offset', () => {
      const page1 = store.listLessons(projectId, { limit: 2, offset: 0 });
      const page2 = store.listLessons(projectId, { limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('listFileDigests pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 8; i++) {
        store.upsertFileDigest({ projectId, path: `src/file${i}.ts` });
      }
    });

    it('should respect limit and offset', () => {
      const page1 = store.listFileDigests(projectId, { limit: 3, offset: 0 });
      const page2 = store.listFileDigests(projectId, { limit: 3, offset: 3 });

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('listSnapshots pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        store.createSnapshot(projectId, `snapshot-${i}`);
      }
    });

    it('should respect limit and offset', () => {
      const page1 = store.listSnapshots(projectId, 2, 0);
      const page2 = store.listSnapshots(projectId, 2, 2);

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('listEntitiesPage cursor pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 12; i++) {
        store.addEntity({ name: `Entity${i}`, type: 'class', projectId });
      }
    });

    it('returns nextCursor when more rows exist', () => {
      const page = store.listEntitiesPage(projectId, { limit: 5 });
      expect(page.items.length).toBe(5);
      expect(page.nextCursor).not.toBeNull();
    });

    it('returns null cursor on the final page', () => {
      const page = store.listEntitiesPage(projectId, { limit: 100 });
      expect(page.items.length).toBe(12);
      expect(page.nextCursor).toBeNull();
    });

    it('walks all rows without duplicates via cursor', () => {
      const seen = new Set<string>();
      let cursor: string | null | undefined = undefined;
      let pages = 0;
      while (true) {
        const page = store.listEntitiesPage(projectId, { limit: 4, cursor });
        for (const e of page.items) seen.add(e.id);
        pages++;
        if (!page.nextCursor || pages > 10) break;
        cursor = page.nextCursor;
      }
      expect(seen.size).toBe(12);
    });

    it('treats malformed cursor as no cursor (no crash)', () => {
      const page = store.listEntitiesPage(projectId, { limit: 5, cursor: 'not-a-cursor' });
      expect(page.items.length).toBe(5);
    });

    it('respects type filter alongside cursor', () => {
      store.addEntity({ name: 'Decision1', type: 'decision', projectId });
      const page = store.listEntitiesPage(projectId, { type: 'decision', limit: 50 });
      expect(page.items.every(e => e.type === 'decision')).toBe(true);
    });
  });

  describe('listIssuesPage cursor pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 9; i++) {
        store.addIssue({ projectId, type: 'bug', title: `Issue ${i}` });
      }
    });

    it('walks all issues via cursor without duplicates', () => {
      const seen = new Set<string>();
      let cursor: string | null | undefined = undefined;
      let pages = 0;
      while (true) {
        const page = store.listIssuesPage(projectId, { limit: 3, cursor });
        for (const i of page.items) seen.add(i.id);
        pages++;
        if (!page.nextCursor || pages > 10) break;
        cursor = page.nextCursor;
      }
      expect(seen.size).toBe(9);
    });

    it('combines status filter with cursor', () => {
      store.updateIssue(store.listIssues(projectId)[0].id, { status: 'resolved' });
      const open = store.listIssuesPage(projectId, { status: 'open', limit: 50 });
      expect(open.items.every(i => i.status === 'open')).toBe(true);
      expect(open.items.length).toBe(8);
    });
  });
});
