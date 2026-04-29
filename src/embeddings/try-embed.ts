import type { EmbeddingProvider } from './provider.js';

export interface TryEmbedFailure {
  readonly label: string;
  readonly error: string;
  readonly at: string;
}

/**
 * Best-effort embed wrapper for non-critical embedding paths.
 *
 * Use this when an embed failure should NOT abort the surrounding work
 * (tool insertion, lesson generation, session start) but you still want:
 *   - the failure logged on stderr (visible in MCP server logs)
 *   - the failure recorded so health/diagnostics can surface "embedder degraded"
 *   - a clear `null` return that callers must handle, instead of a swallowed
 *     `try { ... } catch { }` block that hides the failure entirely.
 *
 * Replaces ~15 sites that previously did:
 *   try { const v = await provider.embed(x); ... } catch { console.error(...) }
 *
 * Failures are appended to the optional `failureSink` so callers (e.g. tools
 * that already track per-call success counters) can roll them up into their
 * response. If no sink is provided, failures are still logged via `console.error`.
 */
export async function tryEmbed(
  provider: EmbeddingProvider,
  text: string,
  label: string,
  failureSink?: TryEmbedFailure[],
): Promise<number[] | null> {
  try {
    const v = await provider.embed(text);
    // NoOp returns []. Treat as "no embedding produced" rather than success.
    if (v.length === 0) return null;
    return v;
  } catch (err) {
    const failure: TryEmbedFailure = {
      label,
      error: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    };
    if (failureSink) failureSink.push(failure);
    console.error(`[embed:${label}] ${failure.error}`);
    return null;
  }
}
