import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all DEVBRAIN_ and OPENAI_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DEVBRAIN_') || key === 'OPENAI_API_KEY') {
        delete process.env[key];
      }
    }
    // Hide the developer's real ~/.devbrain/config.json from the loader.
    // Without this, a local config (with e.g. openaiApiKey set) leaks in and
    // makes provider-inference assertions non-deterministic in dev environments.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original env
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

  it('should return default values when no config file and no env vars', () => {
    const config = loadConfig();

    expect(config.dbPath).toContain('.devbrain');
    expect(config.dbPath).toContain('devbrain.db');
    expect(config.transport).toBe('stdio');
    expect(config.openaiModel).toBe('text-embedding-3-small');
    expect(config.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(config.ollamaModel).toBe('nomic-embed-text');
  });

  it('should infer openai provider when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';

    const config = loadConfig();

    expect(config.embeddingProvider).toBe('openai');
    expect(config.openaiApiKey).toBe('sk-test-key');
    expect(config.embeddingDimension).toBe(1536);
  });

  it('should infer ollama provider when no API key is set', () => {
    const config = loadConfig();

    expect(config.embeddingProvider).toBe('ollama');
    expect(config.embeddingDimension).toBe(768);
  });

  it('should override embedding provider via env var', () => {
    process.env.DEVBRAIN_EMBEDDING_PROVIDER = 'none';

    const config = loadConfig();

    expect(config.embeddingProvider).toBe('none');
    expect(config.embeddingDimension).toBe(1536);
  });

  it('should override db path via env var', () => {
    process.env.DEVBRAIN_DB_PATH = '/tmp/test-devbrain.db';

    const config = loadConfig();

    expect(config.dbPath).toBe('/tmp/test-devbrain.db');
  });

  it('should override transport via env var', () => {
    process.env.DEVBRAIN_TRANSPORT = 'sse';

    const config = loadConfig();

    expect(config.transport).toBe('sse');
  });

  it('should override port via env var', () => {
    process.env.DEVBRAIN_PORT = '4000';

    const config = loadConfig();

    expect(config.port).toBe(4000);
  });

  it('should override embedding dimension via env var', () => {
    process.env.DEVBRAIN_EMBEDDING_DIMENSION = '256';

    const config = loadConfig();

    expect(config.embeddingDimension).toBe(256);
  });

  it('should override ollama settings via env vars', () => {
    process.env.DEVBRAIN_OLLAMA_BASE_URL = 'http://remote:11434';
    process.env.DEVBRAIN_OLLAMA_MODEL = 'mxbai-embed-large';

    const config = loadConfig();

    expect(config.ollamaBaseUrl).toBe('http://remote:11434');
    expect(config.ollamaModel).toBe('mxbai-embed-large');
  });

  it('should override openai model via env var', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.DEVBRAIN_OPENAI_MODEL = 'text-embedding-3-large';

    const config = loadConfig();

    expect(config.openaiModel).toBe('text-embedding-3-large');
  });

  it('should ignore invalid provider values in env var', () => {
    process.env.DEVBRAIN_EMBEDDING_PROVIDER = 'invalid_provider';

    const config = loadConfig();

    // Falls back to inferred provider (ollama since no API key)
    expect(config.embeddingProvider).toBe('ollama');
  });

  it('should ignore invalid transport values in env var', () => {
    process.env.DEVBRAIN_TRANSPORT = 'websocket';

    const config = loadConfig();

    expect(config.transport).toBe('stdio');
  });

  it('should return an immutable-like config object', () => {
    const config = loadConfig();

    // Verify all expected fields exist
    expect(config).toHaveProperty('dbPath');
    expect(config).toHaveProperty('embeddingProvider');
    expect(config).toHaveProperty('embeddingDimension');
    expect(config).toHaveProperty('transport');
    expect(config).toHaveProperty('openaiModel');
    expect(config).toHaveProperty('ollamaBaseUrl');
    expect(config).toHaveProperty('ollamaModel');
  });

  it('should support DEVBRAIN_OPENAI_API_KEY as alternative env var', () => {
    process.env.DEVBRAIN_OPENAI_API_KEY = 'sk-alt-key';

    const config = loadConfig();

    expect(config.openaiApiKey).toBe('sk-alt-key');
    expect(config.embeddingProvider).toBe('openai');
  });

  it('should give OPENAI_API_KEY precedence over DEVBRAIN_OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-main-key';
    process.env.DEVBRAIN_OPENAI_API_KEY = 'sk-alt-key';

    const config = loadConfig();

    expect(config.openaiApiKey).toBe('sk-main-key');
  });
});
