import type { EmbeddingProvider } from './provider.js';

// 10s timeout — OpenAI embeddings normally complete in <1s. A longer wait
// (rate-limit retry, network stall) blocks every embed call site.
const DEFAULT_TIMEOUT_MS = 10_000;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  readonly dimension = 1536;

  constructor(apiKey: string, model: string = 'text-embedding-3-small', timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = Math.max(1000, timeoutMs);
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        data: { embedding: number[]; index: number }[];
      };

      return data.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`OpenAI embed timeout after ${this.timeoutMs}ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
