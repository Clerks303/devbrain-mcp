/**
 * Serialized write queue — ensures DB writes don't overlap.
 * Operations are processed one at a time in FIFO order.
 * SQLITE_BUSY errors trigger exponential backoff retries.
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

export class WriteQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private _processedCount = 0;
  private _errorCount = 0;

  get processedCount(): number { return this._processedCount; }
  get errorCount(): number { return this._errorCount; }
  get pending(): number { return this.queue.length; }

  async enqueue(operation: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await this.withRetry(operation);
          this._processedCount++;
          resolve();
        } catch (err) {
          this._errorCount++;
          reject(err);
        }
      });
      if (!this.processing) {
        void this.process();
      }
    });
  }

  /** Flush all pending operations. Returns when the queue is empty. */
  async flush(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return;
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.processing && this.queue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      try {
        await op();
      } catch (err) {
        console.error('[WriteQueue] Operation failed:', err);
      }
    }
    this.processing = false;
  }

  private async withRetry(fn: () => Promise<void>): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await fn();
        return;
      } catch (err: unknown) {
        if (attempt >= MAX_RETRIES) throw err;
        const isBusy = err instanceof Error && err.message.includes('SQLITE_BUSY');
        if (!isBusy) throw err;
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delayMs));
        attempt++;
      }
    }
  }
}
