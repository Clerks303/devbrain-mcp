import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaEmbeddingProvider } from '../../src/embeddings/ollama.js';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai.js';

// Regression: the embed providers used `await fetch(...)` with no
// AbortController, so a hung Ollama process or stalled OpenAI rate-limit
// retry would block every embed call site (sync tools, hook handlers,
// learning engine) for as long as the network read took. With Node's
// default keep-alive socket reuse and OpenAI's ~30s server-side timeout,
// this could pin the MCP server for half a minute per failed call.

describe('Embedding providers — fetch timeout', () => {
  const realFetch = global.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('Ollama aborts the request when the configured timeout elapses', async () => {
    let receivedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
      receivedSignal = opts.signal;
      // Never resolve — wait for abort
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const provider = new OllamaEmbeddingProvider(
      'http://localhost:11434', 'nomic-embed-text', 4, 50,
    );

    await expect(provider.embed('hello')).rejects.toThrow(/timeout after \d+ms/);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('OpenAI aborts the request when the configured timeout elapses', async () => {
    let receivedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
      receivedSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const provider = new OpenAIEmbeddingProvider('sk-test', 'text-embedding-3-small', 50);

    await expect(provider.embed('hello')).rejects.toThrow(/timeout after \d+ms/);
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('Ollama does NOT abort when the response arrives in time', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2] }),
    } as Response);

    const provider = new OllamaEmbeddingProvider(
      'http://localhost:11434', 'nomic-embed-text', 4, 5000,
    );

    const result = await provider.embed('hello');
    expect(result).toEqual([0.1, 0.2]);
  });

  it('OpenAI does NOT abort when the response arrives in time', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.3, 0.4], index: 0 }] }),
    } as Response);

    const provider = new OpenAIEmbeddingProvider('sk-test', 'text-embedding-3-small', 5000);

    const result = await provider.embed('hello');
    expect(result).toEqual([0.3, 0.4]);
  });
});
