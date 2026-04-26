import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');

  const statements = `
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
  `;
  db.exec(statements);

  return db;
}

describe('KnowledgeStore', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('entities', () => {
    it('should add and retrieve an entity', () => {
      const entity = store.addEntity({ name: 'UserService', type: 'class', content: 'Handles user operations' });
      expect(entity.id).toBeDefined();
      expect(entity.name).toBe('UserService');
      expect(entity.type).toBe('class');
      expect(entity.content).toBe('Handles user operations');

      const retrieved = store.getEntity(entity.id);
      expect(retrieved).toEqual(entity);
    });

    it('should update an entity', () => {
      const entity = store.addEntity({ name: 'Foo', type: 'function' });
      const updated = store.updateEntity(entity.id, { name: 'Bar', content: 'Updated content' });
      expect(updated.name).toBe('Bar');
      expect(updated.content).toBe('Updated content');
      expect(updated.type).toBe('function');
    });

    it('should delete an entity', () => {
      const entity = store.addEntity({ name: 'ToDelete', type: 'module' });
      store.deleteEntity(entity.id);
      expect(store.getEntity(entity.id)).toBeNull();
    });

    it('should list entities filtered by project', () => {
      store.addEntity({ name: 'Global', type: 'pattern' });
      store.addEntity({ name: 'ProjectA', type: 'class', projectId: 'proj-1' });
      store.addEntity({ name: 'ProjectB', type: 'class', projectId: 'proj-2' });

      const all = store.listEntities();
      expect(all.length).toBe(3);

      const proj1 = store.listEntities('proj-1');
      expect(proj1.length).toBe(2);
      expect(proj1.map(e => e.name).sort()).toEqual(['Global', 'ProjectA']);

      const globalOnly = store.listEntities(null);
      expect(globalOnly.length).toBe(1);
      expect(globalOnly[0].name).toBe('Global');
    });

    it('should find entities by name', () => {
      store.addEntity({ name: 'UserService', type: 'class' });
      store.addEntity({ name: 'UserController', type: 'class' });
      store.addEntity({ name: 'ProductService', type: 'class' });

      const results = store.findEntitiesByName('User');
      expect(results.length).toBe(2);
    });

    it('should store and retrieve metadata', () => {
      const entity = store.addEntity({
        name: 'Config',
        type: 'module',
        metadata: { language: 'typescript', framework: 'express' },
      });

      const retrieved = store.getEntity(entity.id);
      expect(retrieved!.metadata).toEqual({ language: 'typescript', framework: 'express' });
    });
  });

  describe('relations', () => {
    it('should add and retrieve relations', () => {
      const a = store.addEntity({ name: 'A', type: 'module' });
      const b = store.addEntity({ name: 'B', type: 'module' });
      const relation = store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });

      expect(relation.fromEntityId).toBe(a.id);
      expect(relation.toEntityId).toBe(b.id);
      expect(relation.type).toBe('imports');
      expect(relation.weight).toBe(1.0);

      const fromA = store.getRelations(a.id, 'from');
      expect(fromA.length).toBe(1);

      const toB = store.getRelations(b.id, 'to');
      expect(toB.length).toBe(1);

      const both = store.getRelations(a.id, 'both');
      expect(both.length).toBe(1);
    });

    it('should delete a relation', () => {
      const a = store.addEntity({ name: 'A', type: 'module' });
      const b = store.addEntity({ name: 'B', type: 'module' });
      const relation = store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'calls' });

      store.deleteRelation(relation.id);
      expect(store.getRelations(a.id).length).toBe(0);
    });

    it('should cascade delete relations when entity is deleted', () => {
      const a = store.addEntity({ name: 'A', type: 'module' });
      const b = store.addEntity({ name: 'B', type: 'module' });
      store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });

      store.deleteEntity(a.id);
      expect(store.getRelations(b.id).length).toBe(0);
    });
  });

  describe('observations', () => {
    it('should add and retrieve observations', () => {
      const entity = store.addEntity({ name: 'Auth', type: 'module' });
      const obs = store.addObservation({
        entityId: entity.id,
        content: 'Uses JWT tokens for authentication',
        source: 'user',
      });

      expect(obs.entityId).toBe(entity.id);
      expect(obs.content).toBe('Uses JWT tokens for authentication');
      expect(obs.source).toBe('user');

      const observations = store.getObservations(entity.id);
      expect(observations.length).toBe(1);
      expect(observations[0].id).toBe(obs.id);
    });

    it('should delete an observation', () => {
      const entity = store.addEntity({ name: 'Auth', type: 'module' });
      const obs = store.addObservation({ entityId: entity.id, content: 'test' });

      store.deleteObservation(obs.id);
      expect(store.getObservations(entity.id).length).toBe(0);
    });
  });

  describe('projects', () => {
    it('should add and list projects', () => {
      const project = store.addProject({ name: 'MyProject', path: '/home/user/myproject' });
      expect(project.name).toBe('MyProject');
      expect(project.path).toBe('/home/user/myproject');

      const projects = store.listProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].id).toBe(project.id);
    });

    it('should find project by path', () => {
      store.addProject({ name: 'MyProject', path: '/home/user/myproject' });
      const found = store.getProjectByPath('/home/user/myproject');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('MyProject');

      const notFound = store.getProjectByPath('/nonexistent');
      expect(notFound).toBeNull();
    });
  });

  describe('graph summary', () => {
    it('should return correct counts', () => {
      const a = store.addEntity({ name: 'A', type: 'module' });
      const b = store.addEntity({ name: 'B', type: 'class' });
      store.addRelation({ fromEntityId: a.id, toEntityId: b.id, type: 'imports' });
      store.addObservation({ entityId: a.id, content: 'Important module' });

      const summary = store.getGraphSummary();
      expect(summary.entityCount).toBe(2);
      expect(summary.relationCount).toBe(1);
      expect(summary.observationCount).toBe(1);
      expect(summary.entityTypes['module']).toBe(1);
      expect(summary.entityTypes['class']).toBe(1);
      expect(summary.topEntities.length).toBeGreaterThan(0);
    });
  });
});
