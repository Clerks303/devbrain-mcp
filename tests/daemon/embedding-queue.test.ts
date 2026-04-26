import { describe, it, expect } from 'vitest';
import { EmbeddingQueue } from '../../src/daemon/embedding-queue.js';

describe('EmbeddingQueue', () => {
  it('should process items sequentially', async () => {
    const queue = new EmbeddingQueue(10); // fast for testing
    const results: number[] = [];

    queue.enqueue(async () => { results.push(1); });
    queue.enqueue(async () => { results.push(2); });
    queue.enqueue(async () => { results.push(3); });

    await queue.flush();

    expect(results).toEqual([1, 2, 3]);
    expect(queue.processedCount).toBe(3);
  });

  it('should handle errors without stopping', async () => {
    const queue = new EmbeddingQueue(10);
    const results: number[] = [];

    queue.enqueue(async () => { results.push(1); });
    queue.enqueue(async () => { throw new Error('fail'); });
    queue.enqueue(async () => { results.push(3); });

    await queue.flush();

    expect(results).toEqual([1, 3]);
    expect(queue.processedCount).toBe(2);
    expect(queue.errorCount).toBe(1);
  });

  it('should report pending count', async () => {
    const queue = new EmbeddingQueue(10);
    expect(queue.pending).toBe(0);
  });
});
