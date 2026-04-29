import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

// Regression: parseInt("abc") returns NaN, and `NaN ?? fallback` is still
// NaN (NaN is not nullish). Previously this propagated to the embedding
// dimension (vec0 dim must be > 0) and to port numbers, breaking the DB
// boot or leaving the server bound to a NaN port.

describe('loadConfig — numeric env var validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DEVBRAIN_') || key === 'OPENAI_API_KEY') {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DEVBRAIN_') || key === 'OPENAI_API_KEY') {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (key.startsWith('DEVBRAIN_') || key === 'OPENAI_API_KEY') {
        process.env[key] = value;
      }
    }
  });

  it('falls back to provider default when DEVBRAIN_EMBEDDING_DIMENSION is non-numeric', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVBRAIN_EMBEDDING_DIMENSION = 'not-a-number';
    process.env.DEVBRAIN_EMBEDDING_PROVIDER = 'ollama';

    const config = loadConfig();

    expect(config.embeddingDimension).toBe(768);
    expect(Number.isFinite(config.embeddingDimension)).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('falls back to provider default when DEVBRAIN_EMBEDDING_DIMENSION is empty string', () => {
    process.env.DEVBRAIN_EMBEDDING_DIMENSION = '';
    process.env.DEVBRAIN_EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';

    const config = loadConfig();

    expect(config.embeddingDimension).toBe(1536);
  });

  it('rejects negative or zero dimension', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVBRAIN_EMBEDDING_DIMENSION = '-100';
    process.env.DEVBRAIN_EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';

    const config = loadConfig();

    expect(config.embeddingDimension).toBe(1536);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('accepts valid positive dimension override', () => {
    process.env.DEVBRAIN_EMBEDDING_DIMENSION = '512';
    process.env.DEVBRAIN_EMBEDDING_PROVIDER = 'ollama';

    const config = loadConfig();

    expect(config.embeddingDimension).toBe(512);
  });

  it('falls back to default hookPort when DEVBRAIN_HOOK_PORT is non-numeric', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVBRAIN_HOOK_PORT = 'garbage';

    const config = loadConfig();

    expect(config.hookPort).toBe(7384);
    expect(Number.isFinite(config.hookPort)).toBe(true);
    errSpy.mockRestore();
  });

  it('leaves port undefined when DEVBRAIN_PORT is non-numeric (no fallback in file/default)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVBRAIN_PORT = 'NaN';

    const config = loadConfig();

    expect(config.port).toBeUndefined();
    errSpy.mockRestore();
  });
});
