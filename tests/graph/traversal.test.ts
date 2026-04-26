import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';
import { traverse } from '../../src/graph/traversal.js';

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
  `);
  return db;
}

describe('Graph Traversal', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should traverse a simple chain with BFS', () => {
    const a = store.addEntity({ name: 'A', type: 'module' });
    const b = store.addEntity({ name: 'B', type: 'module' });
    const c = store.addEntity({ name: 'C', type: 'module' });

    store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
    store.addRelation({ fromEntityId: b.id, toEntityId: c.id, type: 'imports' });

    const results = traverse(store, a.id, { maxDepth: 3, algorithm: 'bfs' });
    expect(results.length).toBe(3);
    expect(results[0].entity.name).toBe('A');
    expect(results[0].depth).toBe(0);
    expect(results[1].entity.name).toBe('B');
    expect(results[1].depth).toBe(1);
    expect(results[2].entity.name).toBe('C');
    expect(results[2].depth).toBe(2);
  });

  it('should respect maxDepth', () => {
    const a = store.addEntity({ name: 'A', type: 'module' });
    const b = store.addEntity({ name: 'B', type: 'module' });
    const c = store.addEntity({ name: 'C', type: 'module' });

    store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
    store.addRelation({ fromEntityId: b.id, toEntityId: c.id, type: 'imports' });

    const results = traverse(store, a.id, { maxDepth: 1, algorithm: 'bfs' });
    expect(results.length).toBe(2);
  });

  it('should handle direction filtering', () => {
    const a = store.addEntity({ name: 'A', type: 'module' });
    const b = store.addEntity({ name: 'B', type: 'module' });
    const c = store.addEntity({ name: 'C', type: 'module' });

    store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
    store.addRelation({ fromEntityId: c.id, toEntityId: a.id, type: 'imports' });

    const outgoing = traverse(store, a.id, { direction: 'outgoing', maxDepth: 2 });
    expect(outgoing.map(n => n.entity.name)).toEqual(['A', 'B']);

    const incoming = traverse(store, a.id, { direction: 'incoming', maxDepth: 2 });
    expect(incoming.map(n => n.entity.name)).toEqual(['A', 'C']);

    const both = traverse(store, a.id, { direction: 'both', maxDepth: 2 });
    expect(both.length).toBe(3);
  });

  it('should filter by relation types', () => {
    const a = store.addEntity({ name: 'A', type: 'module' });
    const b = store.addEntity({ name: 'B', type: 'module' });
    const c = store.addEntity({ name: 'C', type: 'module' });

    store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
    store.addRelation({ fromEntityId: a.id, toEntityId: c.id, type: 'calls' });

    const importsOnly = traverse(store, a.id, { relationTypes: ['imports'], maxDepth: 2 });
    expect(importsOnly.length).toBe(2);
    expect(importsOnly.map(n => n.entity.name)).toEqual(['A', 'B']);
  });

  it('should handle cycles without infinite loops', () => {
    const a = store.addEntity({ name: 'A', type: 'module' });
    const b = store.addEntity({ name: 'B', type: 'module' });

    store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
    store.addRelation({ fromEntityId: b.id, toEntityId: a.id, type: 'imports' });

    const results = traverse(store, a.id, { maxDepth: 5 });
    expect(results.length).toBe(2);
  });

  it('should traverse with DFS', () => {
    const a = store.addEntity({ name: 'A', type: 'module' });
    const b = store.addEntity({ name: 'B', type: 'module' });
    const c = store.addEntity({ name: 'C', type: 'module' });

    store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
    store.addRelation({ fromEntityId: b.id, toEntityId: c.id, type: 'imports' });

    const results = traverse(store, a.id, { maxDepth: 3, algorithm: 'dfs' });
    expect(results.length).toBe(3);
    expect(results[0].entity.name).toBe('A');
  });

  it('should return empty for non-existent entity', () => {
    const results = traverse(store, 'nonexistent', { maxDepth: 2 });
    expect(results.length).toBe(0);
  });
});
