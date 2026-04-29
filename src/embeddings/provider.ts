import type { DevBrainConfig } from '../config.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly isNoOp?: boolean;
}

export async function createEmbeddingProvider(config?: DevBrainConfig): Promise<EmbeddingProvider> {
  const provider = config?.embeddingProvider;
  const apiKey = config?.openaiApiKey ?? process.env.OPENAI_API_KEY;

  // Explicit 'none' means no embedding
  if (provider === 'none') {
    const dimension = config?.embeddingDimension ?? 1536;
    return new NoOpEmbeddingProvider(dimension);
  }

  // Explicit 'openai' or auto-detect via API key
  if (provider === 'openai' || (!provider && apiKey)) {
    if (!apiKey) {
      console.error('Warning: openai provider selected but no API key found. Falling back to no-op.');
      return new NoOpEmbeddingProvider(config?.embeddingDimension ?? 1536);
    }
    const { OpenAIEmbeddingProvider } = await import('./openai.js');
    return new OpenAIEmbeddingProvider(
      apiKey,
      config?.openaiModel ?? 'text-embedding-3-small',
    );
  }

  // Explicit 'ollama' or auto-detect fallback
  try {
    const { OllamaEmbeddingProvider } = await import('./ollama.js');
    const ollamaProvider = new OllamaEmbeddingProvider(
      config?.ollamaBaseUrl ?? 'http://localhost:11434',
      config?.ollamaModel ?? 'nomic-embed-text',
    );
    // Test connectivity
    await ollamaProvider.embed('test');
    return ollamaProvider;
  } catch {
    // No embedding provider available -- use a no-op provider
    console.error(
      'Warning: No embedding provider available. Set OPENAI_API_KEY or run Ollama locally. Semantic search will be disabled.'
    );
    return new NoOpEmbeddingProvider(config?.embeddingDimension ?? 1536);
  }
}

class NoOpEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly isNoOp = true;

  constructor(dimension: number = 1536) {
    this.dimension = dimension;
  }

  // Returns an empty vector. Callers (VectorStore.upsert*, hybrid search)
  // detect length === 0 and skip vector indexing / KNN lookup.
  // Avoids polluting cosine KNN with zero vectors that all sit at distance 1.
  async embed(_text: string): Promise<number[]> {
    return [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}
