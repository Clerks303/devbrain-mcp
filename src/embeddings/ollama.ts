import type { EmbeddingProvider } from './provider.js';

// Concurrency cap for local Ollama. Unbounded Promise.all on a big batch
// (e.g. reindex 1000 files) saturates the local server and risks OOM.
// 4 is a safe default for a local CPU/GPU model — tunable via constructor.
const DEFAULT_CONCURRENCY = 4;

// 30s timeout — local Ollama can be slow on cold-start (model load) but
// anything longer indicates a hung process and would block all callers.
const DEFAULT_TIMEOUT_MS = 30_000;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private concurrency: number;
  private timeoutMs: number;
  readonly dimension = 768; // nomic-embed-text default

  constructor(
    baseUrl = 'http://localhost:11434',
    model = 'nomic-embed-text',
    concurrency: number = DEFAULT_CONCURRENCY,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.concurrency = Math.max(1, concurrency);
    this.timeoutMs = Math.max(1000, timeoutMs);
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as { embedding: number[] };
      return data.embedding;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Ollama embed timeout after ${this.timeoutMs}ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= texts.length) return;
        results[i] = await this.embed(texts[i]);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, texts.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }
}
