import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { VectorStore, vectorToBlob } from '../../src/db/vector.js';
import { KnowledgeStore } from '../../src/db/store.js';

const DIM = 4;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');

  const sql = `
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT,
      content TEXT, metadata TEXT, status TEXT DEFAULT 'unknown', embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  `;
  db.exec(sql);
  return db;
}

function randomVector(dim: number): number[] {
  const v = Array.from({ length: dim }, () => Math.random());
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map(x => x / norm);
}

describe('VectorStore', () => {
  let db: Database.Database;
  let vectorStore: VectorStore;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    vectorStore = new VectorStore(db);
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should convert vectors to blobs correctly', () => {
    const vec = [1.0, 2.0, 3.0, 4.0];
    const blob = vectorToBlob(vec);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.byteLength).toBe(DIM * 4);
  });

  it('should upsert and search entity embeddings', () => {
    const entity = store.addEntity({ name: 'Test', type: 'function' });
    const embedding = randomVector(DIM);

    vectorStore.upsertEntityEmbedding(entity.id, embedding);

    const results = vectorStore.searchEntities(embedding, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(entity.id);
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('should find similar entities', () => {
    const e1 = store.addEntity({ name: 'Similar1', type: 'function' });
    const e2 = store.addEntity({ name: 'Similar2', type: 'function' });
    const e3 = store.addEntity({ name: 'Different', type: 'function' });

    const baseVec = [1, 0, 0, 0];
    const similarVec = [0.9, 0.1, 0, 0];
    const differentVec = [0, 0, 0, 1];

    vectorStore.upsertEntityEmbedding(e1.id, baseVec);
    vectorStore.upsertEntityEmbedding(e2.id, similarVec);
    vectorStore.upsertEntityEmbedding(e3.id, differentVec);

    const results = vectorStore.searchEntities(baseVec, 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe(e1.id);
  });

  it('should upsert (replace) embeddings', () => {
    const entity = store.addEntity({ name: 'Test', type: 'function' });

    vectorStore.upsertEntityEmbedding(entity.id, [1, 0, 0, 0]);
    vectorStore.upsertEntityEmbedding(entity.id, [0, 1, 0, 0]);

    const results = vectorStore.searchEntities([0, 1, 0, 0], 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(entity.id);
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('should delete entity embeddings', () => {
    const entity = store.addEntity({ name: 'Test', type: 'function' });
    vectorStore.upsertEntityEmbedding(entity.id, randomVector(DIM));

    vectorStore.deleteEntityEmbedding(entity.id);

    const results = vectorStore.searchEntities(randomVector(DIM), 5);
    expect(results.length).toBe(0);
  });

  it('should handle observation embeddings', () => {
    const entity = store.addEntity({ name: 'Test', type: 'function' });
    const obs = store.addObservation({ entityId: entity.id, content: 'test observation' });
    const embedding = randomVector(DIM);

    vectorStore.upsertObservationEmbedding(obs.id, embedding);

    const results = vectorStore.searchObservations(embedding, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(obs.id);
  });
});
