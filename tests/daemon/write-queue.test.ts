import { describe, it, expect } from 'vitest';
import { WriteQueue } from '../../src/daemon/write-queue.js';

describe('WriteQueue', () => {
  it('should process operations in order', async () => {
    const queue = new WriteQueue();
    const results: number[] = [];

    await queue.enqueue(async () => { results.push(1); });
    await queue.enqueue(async () => { results.push(2); });
    await queue.enqueue(async () => { results.push(3); });
    await queue.flush();

    expect(results).toEqual([1, 2, 3]);
    expect(queue.processedCount).toBe(3);
    expect(queue.errorCount).toBe(0);
  });

  it('should handle errors without blocking the queue', async () => {
    const queue = new WriteQueue();
    const results: number[] = [];

    await queue.enqueue(async () => { results.push(1); });

    try {
      await queue.enqueue(async () => { throw new Error('test error'); });
    } catch { /* expected */ }

    await queue.enqueue(async () => { results.push(3); });
    await queue.flush();

    expect(results).toEqual([1, 3]);
    expect(queue.errorCount).toBe(1);
  });

  it('should report pending count', async () => {
    const queue = new WriteQueue();
    expect(queue.pending).toBe(0);
  });

  it('should retry on SQLITE_BUSY', async () => {
    const queue = new WriteQueue();
    let attempts = 0;

    await queue.enqueue(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('SQLITE_BUSY');
      }
    });
    await queue.flush();

    expect(attempts).toBe(3);
    expect(queue.processedCount).toBe(1);
  });

  it('should fail after max retries on SQLITE_BUSY', async () => {
    const queue = new WriteQueue();
    let attempts = 0;

    try {
      await queue.enqueue(async () => {
        attempts++;
        throw new Error('SQLITE_BUSY');
      });
    } catch { /* expected */ }

    await queue.flush();
    // MAX_RETRIES = 3, so 4 attempts total (initial + 3 retries)
    expect(attempts).toBe(4);
    expect(queue.errorCount).toBe(1);
  });

  it('should not retry non-BUSY errors', async () => {
    const queue = new WriteQueue();
    let attempts = 0;

    try {
      await queue.enqueue(async () => {
        attempts++;
        throw new Error('some other error');
      });
    } catch { /* expected */ }

    await queue.flush();
    expect(attempts).toBe(1);
  });
});
