/**
 * Rate-limited embedding queue.
 * Processes one embedding at a time with configurable delay between calls.
 * Prevents API rate limit errors from OpenAI/Ollama.
 */

export class EmbeddingQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;
  private readonly rateMs: number;
  private _processedCount = 0;
  private _errorCount = 0;

  constructor(rateMs: number = 100) {
    this.rateMs = rateMs;
  }

  get processedCount(): number { return this._processedCount; }
  get errorCount(): number { return this._errorCount; }
  get pending(): number { return this.queue.length; }

  enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn);
    if (!this.running) void this.drain();
  }

  /** Wait until all queued embeddings are processed */
  async flush(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.running && this.queue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      try {
        await fn();
        this._processedCount++;
      } catch (err) {
        this._errorCount++;
        console.error('[EmbeddingQueue] Failed:', err);
      }
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.rateMs));
      }
    }
    this.running = false;
  }
}
