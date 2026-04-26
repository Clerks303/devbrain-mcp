import { describe, it, expect } from 'vitest';
import { estimateTokens, allocateBudget } from '../../src/injector/token-budget.js';
import type { ScoredItem } from '../../src/injector/types.js';

function makeItem(category: ScoredItem['category'], score: number, textLength: number, id?: string): ScoredItem {
  return {
    category,
    score,
    text: 'x'.repeat(textLength),
    id: id ?? `${category}-${score}`,
  };
}

describe('estimateTokens', () => {
  it('should estimate ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('should handle empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('allocateBudget', () => {
  it('should allocate items to correct categories', () => {
    const items: ScoredItem[] = [
      makeItem('rule', 1.0, 40, 'r1'),
      makeItem('entity', 0.8, 80, 'e1'),
      makeItem('lesson', 0.7, 60, 'l1'),
      makeItem('issue', 0.6, 40, 'i1'),
      makeItem('session', 0.65, 40, 's1'),
      makeItem('neighbor', 0.45, 40, 'n1'),
    ];

    const result = allocateBudget(items);
    expect(result.rules).toHaveLength(1);
    expect(result.entities).toHaveLength(1);
    expect(result.lessons).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.session).toHaveLength(1);
    expect(result.neighbors).toHaveLength(1);
  });

  it('should respect category budget limits', () => {
    // Create items that exceed the rule budget (400 tokens = ~1600 chars)
    const items: ScoredItem[] = [
      makeItem('rule', 1.0, 800, 'r1'),  // 200 tokens
      makeItem('rule', 0.9, 800, 'r2'),  // 200 tokens → 400 total, at limit
      makeItem('rule', 0.8, 800, 'r3'),  // Would exceed 400 budget → skipped
    ];

    const result = allocateBudget(items);
    expect(result.rules).toHaveLength(2);
  });

  it('should never exceed total max tokens (1800)', () => {
    // Create many items across categories
    const items: ScoredItem[] = [];
    for (let i = 0; i < 20; i++) {
      items.push(makeItem('entity', 0.9 - i * 0.01, 400, `e${i}`)); // ~100 tokens each
    }

    const result = allocateBudget(items);
    expect(result.totalTokens).toBeLessThanOrEqual(1800);
  });

  it('should prioritize rules first', () => {
    const items: ScoredItem[] = [
      makeItem('rule', 1.0, 1200, 'r1'),   // 300 tokens
      makeItem('entity', 0.9, 1200, 'e1'),  // 300 tokens
      makeItem('entity', 0.85, 1200, 'e2'), // 300 tokens
      makeItem('entity', 0.8, 1200, 'e3'),  // 300 tokens → would push total
    ];

    const result = allocateBudget(items);
    // Rules should always be included first
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe('r1');
  });

  it('should reduce budget after 50 turns', () => {
    // Spread items across multiple categories so total budget is the constraint
    const items: ScoredItem[] = [
      ...Array.from({ length: 5 }, (_, i) => makeItem('rule', 1.0 - i * 0.01, 200, `r${i}`)),       // 5×50=250
      ...Array.from({ length: 8 }, (_, i) => makeItem('entity', 0.9 - i * 0.01, 400, `e${i}`)),     // 8×100=800
      ...Array.from({ length: 4 }, (_, i) => makeItem('lesson', 0.8 - i * 0.01, 200, `l${i}`)),     // 4×50=200
      ...Array.from({ length: 4 }, (_, i) => makeItem('issue', 0.7 - i * 0.01, 200, `is${i}`)),     // 4×50=200
      ...Array.from({ length: 3 }, (_, i) => makeItem('neighbor', 0.5 - i * 0.01, 200, `n${i}`)),   // 3×50=150
    ];

    const normal = allocateBudget(items, 10);   // max 1800 total
    const reduced = allocateBudget(items, 60);   // max 800 total

    expect(reduced.totalTokens).toBeLessThanOrEqual(800);
    expect(reduced.totalTokens).toBeLessThan(normal.totalTokens);
  });

  it('should skip items that individually exceed remaining category budget', () => {
    const items: ScoredItem[] = [
      makeItem('rule', 1.0, 200, 'r1'),   // 50 tokens
      makeItem('rule', 0.9, 1800, 'r2'),  // 450 tokens → exceeds 400 budget → skip
      makeItem('rule', 0.8, 200, 'r3'),   // 50 tokens → fits
    ];

    const result = allocateBudget(items);
    expect(result.rules).toHaveLength(2);
    expect(result.rules.map(r => r.id)).toEqual(['r1', 'r3']);
  });

  it('should return empty allocation for empty input', () => {
    const result = allocateBudget([]);
    expect(result.rules).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
    expect(result.lessons).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
    expect(result.session).toHaveLength(0);
    expect(result.neighbors).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
  });

  it('should not redistribute unused budget from one category to another', () => {
    // No rules, but entity budget should stay at 700
    const items: ScoredItem[] = [];
    for (let i = 0; i < 15; i++) {
      items.push(makeItem('entity', 0.9 - i * 0.01, 240, `e${i}`)); // ~60 tokens each
    }

    const result = allocateBudget(items);
    // Entity budget is 700 → max ~11 items of 60 tokens = 660
    // Without redistribution, should not exceed 700 for entities
    const entityTokens = result.entities.reduce(
      (sum, item) => sum + Math.ceil(item.text.length / 4),
      0
    );
    expect(entityTokens).toBeLessThanOrEqual(700);
  });
});
