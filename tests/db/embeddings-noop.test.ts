import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase } from '../../src/db/schema.js';
import { VectorStore } from '../../src/db/vector.js';
import { createEmbeddingProvider } from '../../src/embeddings/provider.js';

// Regression: NoOp must not pollute KNN with zero vectors.
// Before this fix, NoOp returned [0,0,…,0] which all sit at cosine distance 1
// and biased every search.

describe('NoOp embedding provider — KNN safety', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-noop-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array (not zero vector) for embed()', async () => {
    const provider = await createEmbeddingProvider({
      dbPath,
      embeddingProvider: 'none',
      embeddingDimension: 1536,
      transport: 'stdio',
    });

    const v = await provider.embed('hello');
    expect(v).toEqual([]);
    expect((provider as { isNoOp?: boolean }).isNoOp).toBe(true);
  });

  it('embedBatch returns empty arrays — no zero-vector leak', async () => {
    const provider = await createEmbeddingProvider({
      dbPath,
      embeddingProvider: 'none',
      embeddingDimension: 1536,
      transport: 'stdio',
    });

    const vs = await provider.embedBatch(['a', 'b', 'c']);
    expect(vs).toEqual([[], [], []]);
  });

  it('VectorStore.upsert silently skips empty embeddings (no row inserted)', () => {
    const db = initDatabase(dbPath, 1536);
    const vec = new VectorStore(db);

    // Should not throw and should not insert a row
    vec.upsertEntityEmbedding('id-1', []);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM entity_embeddings').get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it('VectorStore.search returns [] when given an empty query embedding', () => {
    const db = initDatabase(dbPath, 1536);
    const vec = new VectorStore(db);

    expect(vec.searchEntities([])).toEqual([]);
    expect(vec.searchObservations([])).toEqual([]);
    expect(vec.searchIssues([])).toEqual([]);
    expect(vec.searchSessions([])).toEqual([]);
    expect(vec.searchRules([])).toEqual([]);
    expect(vec.searchLessons([])).toEqual([]);
    expect(vec.searchFileDigests([])).toEqual([]);
    db.close();
  });
});
