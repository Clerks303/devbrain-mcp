import type { ScoredItem, TokenBudgetAllocation } from './types.js';

/** Token budget allocation by category (in priority order) */
const CATEGORY_BUDGETS: ReadonlyArray<{ category: ScoredItem['category']; maxTokens: number }> = [
  { category: 'rule', maxTokens: 400 },
  { category: 'session', maxTokens: 150 },
  { category: 'entity', maxTokens: 700 },
  { category: 'lesson', maxTokens: 250 },
  { category: 'issue', maxTokens: 200 },
  { category: 'neighbor', maxTokens: 100 },
];

const TOTAL_MAX_TOKENS = 1800;
const REDUCED_MAX_TOKENS = 800; // After 50 turns

/** Estimate token count (conservative: ~4 chars per token) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Allocate scored items to categories within token budgets.
 * Items within each category are ordered by score descending.
 * Budget not consumed by one category is NOT redistributed.
 */
export function allocateBudget(
  scoredItems: ScoredItem[],
  sessionTurns?: number,
): TokenBudgetAllocation {
  const maxTotal = (sessionTurns ?? 0) > 50 ? REDUCED_MAX_TOKENS : TOTAL_MAX_TOKENS;
  let totalTokens = 0;

  const allocation: Record<string, ScoredItem[]> = {
    rule: [],
    session: [],
    entity: [],
    lesson: [],
    issue: [],
    neighbor: [],
  };

  for (const { category, maxTokens } of CATEGORY_BUDGETS) {
    // Get items for this category, sorted by score (already sorted globally)
    const categoryItems = scoredItems.filter(item => item.category === category);
    let categoryTokens = 0;

    for (const item of categoryItems) {
      const itemTokens = estimateTokens(item.text);

      // Check both category and total budgets
      if (categoryTokens + itemTokens > maxTokens) continue;
      if (totalTokens + itemTokens > maxTotal) continue;

      allocation[category].push(item);
      categoryTokens += itemTokens;
      totalTokens += itemTokens;
    }
  }

  return {
    rules: allocation.rule,
    session: allocation.session,
    entities: allocation.entity,
    lessons: allocation.lesson,
    issues: allocation.issue,
    neighbors: allocation.neighbor,
    totalTokens,
  };
}
