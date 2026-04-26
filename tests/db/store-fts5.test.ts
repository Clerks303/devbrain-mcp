import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';

function createTestDbWithFts(): Database.Database {
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

  // Create FTS5 tables and triggers
  db.exec(`
    CREATE VIRTUAL TABLE entities_fts USING fts5(
      name, content, type,
      content='entities',
      content_rowid='rowid'
    );

    CREATE TRIGGER entities_fts_insert AFTER INSERT ON entities BEGIN
      INSERT INTO entities_fts(rowid, name, content, type) VALUES (NEW.rowid, NEW.name, NEW.content, NEW.type);
    END;

    CREATE TRIGGER entities_fts_delete AFTER DELETE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, content, type) VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.type);
    END;

    CREATE TRIGGER entities_fts_update AFTER UPDATE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, content, type) VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.type);
      INSERT INTO entities_fts(rowid, name, content, type) VALUES (NEW.rowid, NEW.name, NEW.content, NEW.type);
    END;
  `);

  return db;
}

function createTestDbWithoutFts(): Database.Database {
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

describe('FTS5 search', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDbWithFts();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should find entities by name using FTS5', () => {
    store.addEntity({ name: 'UserService', type: 'class', content: 'Handles user operations' });
    store.addEntity({ name: 'UserController', type: 'class', content: 'HTTP controller for users' });
    store.addEntity({ name: 'ProductService', type: 'class', content: 'Handles products' });

    const results = store.findEntitiesByName('User');
    expect(results.length).toBe(2);
    expect(results.every(e => e.name.includes('User'))).toBe(true);
  });

  it('should find entities with prefix matching', () => {
    store.addEntity({ name: 'AuthModule', type: 'module' });
    store.addEntity({ name: 'AuthService', type: 'class' });
    store.addEntity({ name: 'DatabaseModule', type: 'module' });

    const results = store.findEntitiesByName('Auth');
    expect(results.length).toBe(2);
  });

  it('should find entities filtered by project', () => {
    store.addEntity({ name: 'GlobalEntity', type: 'class' });
    store.addEntity({ name: 'ProjectEntity', type: 'class', projectId: 'proj-1' });
    store.addEntity({ name: 'OtherEntity', type: 'class', projectId: 'proj-2' });

    const proj1Results = store.findEntitiesByName('Entity', 'proj-1');
    // Should include proj-1 entities and global entities
    expect(proj1Results.length).toBe(2);
    expect(proj1Results.some(e => e.name === 'GlobalEntity')).toBe(true);
    expect(proj1Results.some(e => e.name === 'ProjectEntity')).toBe(true);
  });

  it('should return empty array when no match', () => {
    store.addEntity({ name: 'UserService', type: 'class' });

    const results = store.findEntitiesByName('Nonexistent');
    expect(results.length).toBe(0);
  });

  it('should handle entity updates with FTS sync', () => {
    const entity = store.addEntity({ name: 'OldName', type: 'class' });

    // Update the name
    store.updateEntity(entity.id, { name: 'NewName' });

    // Should not find by old name
    const oldResults = store.findEntitiesByName('OldName');
    expect(oldResults.length).toBe(0);

    // Should find by new name
    const newResults = store.findEntitiesByName('NewName');
    expect(newResults.length).toBe(1);
    expect(newResults[0].name).toBe('NewName');
  });

  it('should handle entity deletion with FTS sync', () => {
    const entity = store.addEntity({ name: 'ToDelete', type: 'class' });

    store.deleteEntity(entity.id);

    const results = store.findEntitiesByName('ToDelete');
    expect(results.length).toBe(0);
  });
});

describe('LIKE fallback (no FTS5 tables)', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDbWithoutFts();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should fall back to LIKE when FTS5 tables do not exist', () => {
    store.addEntity({ name: 'UserService', type: 'class' });
    store.addEntity({ name: 'UserController', type: 'class' });
    store.addEntity({ name: 'ProductService', type: 'class' });

    // Should still work via LIKE fallback
    const results = store.findEntitiesByName('User');
    expect(results.length).toBe(2);
  });

  it('should handle substring matching in LIKE mode', () => {
    store.addEntity({ name: 'MyUserService', type: 'class' });

    // LIKE %User% should match substring
    const results = store.findEntitiesByName('User');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('MyUserService');
  });

  it('should handle special characters gracefully', () => {
    store.addEntity({ name: 'file:src/index.ts', type: 'file' });

    // Characters like : and / should work with LIKE fallback
    const results = store.findEntitiesByName('file:src');
    expect(results.length).toBe(1);
  });
});
