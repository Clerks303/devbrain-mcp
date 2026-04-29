import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, EmbeddingDimensionMismatchError } from '../../src/db/schema.js';

// These tests touch the FS because vec0 virtual tables need a real DB file
// (or :memory: with sqlite-vec loaded — schema.ts already handles that).
// We use a temp dir to keep them isolated.

describe('initDatabase — embedding dimension safety', () => {
  let tmpDir: string;
  let dbPath: string;
  const ORIGINAL_FLAG = process.env.DEVBRAIN_ALLOW_EMBEDDING_RECREATE;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-schema-'));
    dbPath = path.join(tmpDir, 'test.db');
    delete process.env.DEVBRAIN_ALLOW_EMBEDDING_RECREATE;
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.DEVBRAIN_ALLOW_EMBEDDING_RECREATE;
    } else {
      process.env.DEVBRAIN_ALLOW_EMBEDDING_RECREATE = ORIGINAL_FLAG;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes cleanly when stored dimension matches requested', () => {
    const db1 = initDatabase(dbPath, 1536);
    db1.close();

    expect(() => {
      const db2 = initDatabase(dbPath, 1536);
      db2.close();
    }).not.toThrow();
  });

  it('throws EmbeddingDimensionMismatchError on dimension change without opt-in', () => {
    const db1 = initDatabase(dbPath, 1536);
    db1.close();

    expect(() => initDatabase(dbPath, 768)).toThrow(EmbeddingDimensionMismatchError);
  });

  it('error message tells the user how to opt in or revert', () => {
    const db1 = initDatabase(dbPath, 1536);
    db1.close();

    try {
      initDatabase(dbPath, 768);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingDimensionMismatchError);
      const err = e as EmbeddingDimensionMismatchError;
      expect(err.storedDimension).toBe(1536);
      expect(err.requestedDimension).toBe(768);
      expect(err.message).toContain('DEVBRAIN_ALLOW_EMBEDDING_RECREATE');
      expect(err.message).toContain('1536');
      expect(err.message).toContain('768');
    }
  });

  it('allows destructive recreate when DEVBRAIN_ALLOW_EMBEDDING_RECREATE=1', () => {
    const db1 = initDatabase(dbPath, 1536);
    db1.close();

    process.env.DEVBRAIN_ALLOW_EMBEDDING_RECREATE = '1';
    const db2 = initDatabase(dbPath, 768);
    const stored = db2.prepare("SELECT value FROM meta WHERE key='embedding_dimension'").get() as { value: string };
    expect(stored.value).toBe('768');
    db2.close();
  });
});
