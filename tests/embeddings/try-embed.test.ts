import { describe, it, expect, vi } from 'vitest';
import { tryEmbed, type TryEmbedFailure } from '../../src/embeddings/try-embed.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

// tryEmbed is the helper that replaced ~15 sites of duplicated
// `try { ... } catch { console.error(...) }` around embed calls. The
// regressions it must protect against:
//   - silent swallow (no log on failure)
//   - confusing NoOp [] return treated as a successful embedding
//   - failure metadata not surfacing back to the caller

function makeProvider(impl: (text: string) => Promise<number[]>): EmbeddingProvider {
  return {
    dimension: 1536,
    embed: impl,
    embedBatch: async (texts) => Promise.all(texts.map(impl)),
  };
}

describe('tryEmbed', () => {
  it('returns the embedding on success', async () => {
    const provider = makeProvider(async () => [0.1, 0.2, 0.3]);
    const result = await tryEmbed(provider, 'hello', 'test');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null when provider returns empty array (NoOp safety)', async () => {
    // Regression: NoOp provider returns []. Old code stored the empty array
    // as if it were a real embedding, then returned 0 hits forever.
    const provider = makeProvider(async () => []);
    const result = await tryEmbed(provider, 'hello', 'test');
    expect(result).toBeNull();
  });

  it('returns null and logs to stderr on embed failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = makeProvider(async () => { throw new Error('boom'); });

    const result = await tryEmbed(provider, 'hello', 'entity:add');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledOnce();
    const logged = errSpy.mock.calls[0][0] as string;
    expect(logged).toContain('[embed:entity:add]');
    expect(logged).toContain('boom');

    errSpy.mockRestore();
  });

  it('appends failure to sink with label/error/timestamp', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = makeProvider(async () => { throw new Error('rate limited'); });
    const sink: TryEmbedFailure[] = [];

    await tryEmbed(provider, 'hello', 'rule:update', sink);

    expect(sink).toHaveLength(1);
    expect(sink[0].label).toBe('rule:update');
    expect(sink[0].error).toBe('rate limited');
    expect(sink[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    errSpy.mockRestore();
  });

  it('handles non-Error throws (e.g. string) without crashing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = makeProvider(async () => { throw 'string error'; });
    const sink: TryEmbedFailure[] = [];

    const result = await tryEmbed(provider, 'hello', 'test', sink);

    expect(result).toBeNull();
    expect(sink[0].error).toBe('string error');

    errSpy.mockRestore();
  });
});
