import type { EmbeddingProvider } from './provider.js';

// Concurrency cap for local Ollama. Unbounded Promise.all on a big batch
// (e.g. reindex 1000 files) saturates the local server and risks OOM.
// 4 is a safe default for a local CPU/GPU model — tunable via constructor.
const DEFAULT_CONCURRENCY = 4;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private concurrency: number;
  readonly dimension = 768; // nomic-embed-text default

  constructor(
    baseUrl = 'http://localhost:11434',
    model = 'nomic-embed-text',
    concurrency: number = DEFAULT_CONCURRENCY,
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.concurrency = Math.max(1, concurrency);
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
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
