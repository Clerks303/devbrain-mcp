import type { KnowledgeStore } from '../db/store.js';
import type { LearningStore } from './learning-store.js';
import type { Session, Rule, SessionEvent } from '../types.js';
import type { RuleProposal } from './types.js';
import { LEARNING_SAFETY } from './types.js';

interface ObservanceResult {
  readonly ruleId: string;
  readonly score: number;
  readonly sampleSize: number;
  readonly conformSessions: number;
}

/**
 * Evaluate rules and generate evolution proposals.
 * Never applies changes directly — all proposals require human approval.
 */
export function evaluateRules(
  projectId: string,
  store: KnowledgeStore,
  learningStore: LearningStore,
  recentSessions: readonly { session: Session; events: readonly SessionEvent[] }[],
): RuleProposal[] {
  if (recentSessions.length < LEARNING_SAFETY.MIN_SESSIONS_FOR_RULE_EVOLUTION) {
    return [];
  }

  // Check pending proposals limit
  const pendingCount = learningStore.countPendingProposals(projectId);
  if (pendingCount >= LEARNING_SAFETY.MAX_PENDING_RULE_PROPOSALS) {
    return [];
  }

  const rules = store.listRules(projectId);
  const proposals: RuleProposal[] = [];

  for (const rule of rules) {
    // Skip auto-generated rules from being evolved further
    if (rule.metadata && (rule.metadata as Record<string, unknown>).auto_generated) continue;

    const observance = computeObservance(rule, recentSessions);

    // Skip rules with insufficient data
    if (observance.sampleSize < LEARNING_SAFETY.MIN_SESSIONS_FOR_RULE_EVOLUTION) continue;

    // Check for existing pending proposal for this rule
    const existingProposals = learningStore.listProposals(projectId, 'pending');
    if (existingProposals.some(p => p.ruleId === rule.id)) continue;

    const proposal = generateProposal(rule, observance);
    if (proposal && pendingCount + proposals.length < LEARNING_SAFETY.MAX_PENDING_RULE_PROPOSALS) {
      const created = learningStore.addProposal({
        projectId,
        ruleId: rule.id,
        currentSeverity: rule.severity,
        proposedSeverity: proposal.proposedSeverity,
        reason: proposal.reason,
        observanceScore: observance.score,
        sampleSize: observance.sampleSize,
      });
      proposals.push(created);

      // Update rule's observance metadata
      try {
        store.updateRule(rule.id, {
          metadata: {
            ...(rule.metadata ?? {}),
            observance_score: observance.score,
            last_evaluated_at: new Date().toISOString(),
          },
        });
      } catch { /* non-critical */ }
    }
  }

  return proposals;
}

/**
 * Compute observance score for a rule across recent sessions.
 * Uses recency-weighted conformity rate.
 */
export function computeObservance(
  rule: Rule,
  recentSessions: readonly { session: Session; events: readonly SessionEvent[] }[],
): ObservanceResult {
  let conformSessions = 0;
  let totalRelevant = 0;
  let recencyWeightedConform = 0;
  let recencyWeightedTotal = 0;

  for (const { session, events } of recentSessions) {
    if (!session.endedAt) continue;

    const isRelevant = isRuleRelevant(rule, events);
    if (!isRelevant) continue;

    totalRelevant++;
    const ageDays = daysSince(session.endedAt);
    const recencyWeight = 1 / (1 + ageDays);

    const isConform = checkConformity(rule, events);
    recencyWeightedTotal += recencyWeight;

    if (isConform) {
      conformSessions++;
      recencyWeightedConform += recencyWeight;
    }
  }

  const score = recencyWeightedTotal > 0
    ? recencyWeightedConform / recencyWeightedTotal
    : 0;

  return {
    ruleId: rule.id,
    score,
    sampleSize: totalRelevant,
    conformSessions,
  };
}

/** Check if a rule is relevant to a session (had opportunity to be applied) */
function isRuleRelevant(rule: Rule, events: readonly SessionEvent[]): boolean {
  if (rule.scope === 'global') return true;

  if (rule.scope === 'file_pattern' && rule.pattern) {
    return events.some(e => {
      if (e.type !== 'tool_call' || !e.metadata) return false;
      const filePath = (e.metadata as Record<string, unknown>).file_path as string | undefined;
      return filePath?.includes(rule.pattern!) ?? false;
    });
  }

  return true;
}

/**
 * Check if a session conformed to a rule (proxy-based, no code analysis).
 * - global: no revert + no bug issue = conform
 * - file_pattern: file edited without error event = conform
 */
function checkConformity(rule: Rule, events: readonly SessionEvent[]): boolean {
  if (rule.scope === 'global') {
    const hasRevert = events.some(e => e.content.includes('git.revert'));
    const hasBug = events.some(e => e.type === 'error' && e.content.includes('bug'));
    return !hasRevert && !hasBug;
  }

  if (rule.scope === 'file_pattern' && rule.pattern) {
    const hasError = events.some(e =>
      e.type === 'error' && e.metadata &&
      ((e.metadata as Record<string, unknown>).file_path as string | undefined)?.includes(rule.pattern!) === true
    );
    return !hasError;
  }

  return true;
}

function generateProposal(
  rule: Rule,
  observance: ObservanceResult,
): { proposedSeverity: string; reason: string } | null {
  // Promotion: should → must
  if (
    rule.severity === 'should' &&
    observance.score >= LEARNING_SAFETY.RULE_PROMOTION_THRESHOLD &&
    observance.sampleSize >= 20
  ) {
    return {
      proposedSeverity: 'must',
      reason: `Observance score ${(observance.score * 100).toFixed(1)}% across ${observance.sampleSize} sessions (≥95% threshold). Rule is consistently followed — promotion recommended.`,
    };
  }

  // Demotion: should → prefer
  if (
    rule.severity === 'should' &&
    observance.score < LEARNING_SAFETY.RULE_DEMOTION_THRESHOLD
  ) {
    return {
      proposedSeverity: 'prefer',
      reason: `Observance score ${(observance.score * 100).toFixed(1)}% across ${observance.sampleSize} sessions (<50% threshold). Rule is frequently not followed — demotion recommended.`,
    };
  }

  // Demotion: must → should (when not consistently followed)
  if (
    rule.severity === 'must' &&
    observance.score < LEARNING_SAFETY.RULE_PROMOTION_THRESHOLD &&
    observance.sampleSize >= 20
  ) {
    return {
      proposedSeverity: 'should',
      reason: `Observance score ${(observance.score * 100).toFixed(1)}% across ${observance.sampleSize} sessions. "must" rule not consistently applied — consider relaxing to "should".`,
    };
  }

  return null;
}

function daysSince(isoDate: string): number {
  return Math.max(0, (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}
