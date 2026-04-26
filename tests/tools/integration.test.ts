import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import { getEntityContext } from '../../src/graph/context.js';
import { traverse } from '../../src/graph/traversal.js';

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
    CREATE VIRTUAL TABLE entity_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE observation_embeddings USING vec0(
      id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine
    );
  `);
  return db;
}

describe('Integration: Full Knowledge Graph Workflow', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let vectorStore: VectorStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    vectorStore = new VectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should support a full project onboarding workflow', () => {
    // 1. Create a project
    const project = store.addProject({ name: 'MyApp', path: '/home/user/myapp' });
    expect(project.name).toBe('MyApp');

    // 2. Add entities
    const authModule = store.addEntity({
      name: 'auth', type: 'module', projectId: project.id,
      content: 'Authentication and authorization module',
    });
    const userService = store.addEntity({
      name: 'UserService', type: 'class', projectId: project.id,
      content: 'Handles user CRUD operations',
    });
    const jwtDecision = store.addEntity({
      name: 'Use JWT for auth', type: 'decision', projectId: project.id,
      content: 'Decided to use JWT tokens instead of sessions',
    });
    const expressPattern = store.addEntity({
      name: 'Express middleware pattern', type: 'pattern', projectId: project.id,
      content: 'All routes use Express middleware for auth/validation',
    });

    // 3. Add relations
    store.addRelation({ fromEntityId: authModule.id, toEntityId: userService.id, type: 'depends_on' });
    store.addRelation({ fromEntityId: authModule.id, toEntityId: jwtDecision.id, type: 'decided_because' });
    store.addRelation({ fromEntityId: authModule.id, toEntityId: expressPattern.id, type: 'implements' });

    // 4. Add observations
    store.addObservation({ entityId: authModule.id, content: 'Uses bcrypt for password hashing', source: 'agent' });
    store.addObservation({ entityId: jwtDecision.id, content: 'JWT chosen for stateless auth', source: 'user' });

    // 5. Add embeddings
    vectorStore.upsertEntityEmbedding(authModule.id, [1, 0, 0, 0]);
    vectorStore.upsertEntityEmbedding(userService.id, [0.8, 0.2, 0, 0]);
    vectorStore.upsertEntityEmbedding(jwtDecision.id, [0.5, 0.5, 0, 0]);
    vectorStore.upsertEntityEmbedding(expressPattern.id, [0, 0, 1, 0]);

    // 6. Verify context retrieval
    const context = getEntityContext(store, authModule.id);
    expect(context).not.toBeNull();
    expect(context!.entity.name).toBe('auth');
    expect(context!.relations.outgoing.length).toBe(3);
    expect(context!.observations.length).toBe(1);

    // 7. Verify graph traversal
    const traversalResult = traverse(store, authModule.id, { maxDepth: 2, direction: 'outgoing' });
    expect(traversalResult.length).toBe(4);

    // 8. Verify vector search
    const searchResults = vectorStore.searchEntities([0.9, 0.1, 0, 0], 3);
    expect(searchResults.length).toBe(3);
    expect([searchResults[0].id, searchResults[1].id]).toContain(authModule.id);

    // 9. Verify graph summary
    const summary = store.getGraphSummary(project.id);
    expect(summary.entityCount).toBe(4);
    expect(summary.relationCount).toBe(3);
    expect(summary.observationCount).toBe(2);
  });

  it('should handle project scoping correctly', () => {
    const project1 = store.addProject({ name: 'Project1', path: '/project1' });
    const project2 = store.addProject({ name: 'Project2', path: '/project2' });

    store.addEntity({ name: 'GlobalPattern', type: 'pattern', content: 'Shared pattern' });
    store.addEntity({ name: 'P1Entity', type: 'class', projectId: project1.id });
    store.addEntity({ name: 'P2Entity', type: 'class', projectId: project2.id });

    const p1Entities = store.listEntities(project1.id);
    expect(p1Entities.map(e => e.name).sort()).toEqual(['GlobalPattern', 'P1Entity']);

    const p2Entities = store.listEntities(project2.id);
    expect(p2Entities.map(e => e.name).sort()).toEqual(['GlobalPattern', 'P2Entity']);

    const all = store.listEntities();
    expect(all.length).toBe(3);
  });
});
