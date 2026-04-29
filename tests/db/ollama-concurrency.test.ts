import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaEmbeddingProvider } from '../../src/embeddings/ollama.js';

// Regression: embedBatch must (a) cap concurrency and (b) preserve order.
// The previous Promise.all(map) was unbounded — saturated the local server
// on big batches.

describe('OllamaEmbeddingProvider — concurrency-limited batch', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('caps in-flight requests at the configured concurrency', async () => {
    let inFlight = 0;
    let maxObserved = 0;

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise(r => setTimeout(r, 10));
      const body = JSON.parse(init.body as string) as { prompt: string };
      inFlight--;
      return new Response(
        JSON.stringify({ embedding: [body.prompt.length, 0, 0] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text', 3);
    const inputs = Array.from({ length: 20 }, (_, i) => `text-${i}`);
    const out = await provider.embedBatch(inputs);

    expect(out.length).toBe(20);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(0);
  });

  it('preserves input order in the output array', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { prompt: string };
      // Random delay to ensure responses arrive out of order
      await new Promise(r => setTimeout(r, Math.random() * 20));
      return new Response(
        JSON.stringify({ embedding: [body.prompt.length] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text', 4);
    const inputs = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'];
    const out = await provider.embedBatch(inputs);

    // Each response encodes the input length — verify order matches inputs
    expect(out.map(v => v[0])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns [] for empty input', async () => {
    const provider = new OllamaEmbeddingProvider();
    const out = await provider.embedBatch([]);
    expect(out).toEqual([]);
  });
});
