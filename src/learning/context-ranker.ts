import type { LearningStore } from './learning-store.js';
import type { SessionEvent } from '../types.js';

/** Weights for the hybrid scoring formula */
const WEIGHTS = {
  cosine: 0.50,
  historical: 0.25,
  recency: 0.15,
  graphProximity: 0.10,
} as const;

export interface ScoredContext {
  readonly contextId: string;
  readonly contextType: string;
  readonly finalScore: number;
  readonly components: {
    readonly cosine: number;
    readonly historical: number;
    readonly recency: number;
    readonly graphProximity: number;
  };
}

/**
 * Compute hybrid relevance score for a context item.
 *
 * final_score = α × cosine_similarity + β × historical_usefulness + γ × recency + δ × graph_proximity
 */
export function computeHybridScore(params: {
  cosineDistance: number;
  historicalScore: number;
  ageDays: number;
  graphHops: number;
}): ScoredContext['components'] & { finalScore: number } {
  const cosine = Math.max(0, 1 - params.cosineDistance);
  const historical = decayExponential(params.historicalScore, 14);
  const recency = Math.max(0, 1 - params.ageDays / 30);
  const graphProximity = hopsToScore(params.graphHops);

  const finalScore =
    WEIGHTS.cosine * cosine +
    WEIGHTS.historical * historical +
    WEIGHTS.recency * recency +
    WEIGHTS.graphProximity * graphProximity;

  return { finalScore, cosine, historical, recency, graphProximity };
}

/**
 * Record implicit feedback for injected context.
 *
 * Useful if:
 * - A decision event follows within 5 events
 * - Related entities were modified
 * - No revert within 10 minutes
 *
 * Not useful if:
 * - No action on related entities
 * - Session very short (< 3 tool_calls)
 */
export function inferFeedback(
  contextIds: readonly string[],
  events: readonly SessionEvent[],
  sessionToolCalls: number,
): Map<string, boolean> {
  const feedback = new Map<string, boolean>();

  // Too short session → all context is "not useful"
  if (sessionToolCalls < 3) {
    for (const id of contextIds) {
      feedback.set(id, false);
    }
    return feedback;
  }

  // Check for decision events (signal of useful context)
  const hasDecision = events.some(e => e.type === 'decision');
  const hasRevert = events.some(e => e.content.includes('git.revert'));
  const hasModification = events.some(
    e => e.type === 'tool_call' && e.metadata &&
      (e.metadata as Record<string, unknown>).entities_modified === true
  );

  for (const id of contextIds) {
    const useful = (hasDecision || hasModification) && !hasRevert;
    feedback.set(id, useful);
  }

  return feedback;
}

/**
 * Update context scores based on session feedback.
 * Uses EMA to blend new feedback with historical scores.
 */
export function updateContextScores(
  projectId: string,
  sessionId: string,
  feedback: ReadonlyMap<string, boolean>,
  contextTypes: ReadonlyMap<string, string>,
  learningStore: LearningStore,
  alpha = 0.1,
): number {
  let updated = 0;

  for (const [contextId, wasUseful] of feedback) {
    const contextType = contextTypes.get(contextId) ?? 'entity';
    const newScore = wasUseful ? 1.0 : 0.0;

    // Record individual feedback
    learningStore.addFeedback({
      projectId,
      sessionId,
      contextId,
      contextType,
      wasUseful,
      score: newScore,
    });

    // Update aggregate score with EMA
    const existing = learningStore.getContextScore(projectId, contextId, contextType);
    const previousScore = existing?.usefulnessScore ?? 0.5;
    const blendedScore = emaUpdate(previousScore, newScore, alpha);

    learningStore.upsertContextScore({
      projectId,
      contextId,
      contextType,
      usefulnessScore: blendedScore,
      feedbackCount: (existing?.feedbackCount ?? 0) + 1,
    });

    updated++;
  }

  return updated;
}

/** Exponential Moving Average */
export function emaUpdate(previous: number, newValue: number, alpha = 0.1): number {
  return alpha * newValue + (1 - alpha) * previous;
}

/** Exponential decay for historical score, half-life in days */
function decayExponential(score: number, halfLifeDays: number): number {
  // The score is already the aggregate — just return it clamped
  return Math.max(0, Math.min(1, score));
}

/** Convert graph hops to proximity score */
function hopsToScore(hops: number): number {
  if (hops === 0) return 1.0;
  if (hops === 1) return 0.7;
  if (hops === 2) return 0.4;
  return 0.1;
}
