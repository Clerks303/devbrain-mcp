import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import { hybridSearch } from '../../src/graph/search.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

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

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = DIM;
  private embeddings = new Map<string, number[]>();

  setEmbedding(text: string, embedding: number[]) {
    this.embeddings.set(text.toLowerCase(), embedding);
  }

  async embed(text: string): Promise<number[]> {
    return this.embeddings.get(text.toLowerCase()) ?? [0.25, 0.25, 0.25, 0.25];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

describe('Hybrid Search', () => {
  let db: Database.Database;
  let store: KnowledgeStore;
  let vectorStore: VectorStore;
  let mockProvider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    vectorStore = new VectorStore(db);
    mockProvider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it('should find entities by vector similarity', async () => {
    const entity = store.addEntity({ name: 'UserAuth', type: 'module', content: 'Authentication module' });
    const embedding = [1, 0, 0, 0];
    vectorStore.upsertEntityEmbedding(entity.id, embedding);

    mockProvider.setEmbedding('authentication', [0.9, 0.1, 0, 0]);

    const results = await hybridSearch(store, vectorStore, mockProvider, 'authentication', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entity.name).toBe('UserAuth');
  });

  it('should find entities by name match', async () => {
    store.addEntity({ name: 'UserService', type: 'class', content: 'User CRUD operations' });
    store.addEntity({ name: 'ProductService', type: 'class', content: 'Product management' });

    const results = await hybridSearch(store, vectorStore, mockProvider, 'User', { limit: 5 });
    const names = results.map(r => r.entity.name);
    expect(names).toContain('UserService');
  });

  it('should filter by entity type', async () => {
    store.addEntity({ name: 'AuthModule', type: 'module' });
    store.addEntity({ name: 'AuthFunction', type: 'function' });

    const results = await hybridSearch(store, vectorStore, mockProvider, 'Auth', {
      limit: 5,
      types: ['module'],
    });

    expect(results.every(r => r.entity.type === 'module')).toBe(true);
  });

  it('should include observations in results', async () => {
    const entity = store.addEntity({ name: 'Config', type: 'module' });
    store.addObservation({ entityId: entity.id, content: 'Uses YAML format', source: 'user' });
    store.addObservation({ entityId: entity.id, content: 'Located at /config/', source: 'agent' });

    const results = await hybridSearch(store, vectorStore, mockProvider, 'Config', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].observations.length).toBe(2);
  });
});
