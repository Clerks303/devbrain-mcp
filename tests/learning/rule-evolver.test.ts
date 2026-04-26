import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRules, computeObservance } from '../../src/learning/rule-evolver.js';
import type { KnowledgeStore } from '../../src/db/store.js';
import type { LearningStore } from '../../src/learning/learning-store.js';
import type { Rule, Session, SessionEvent } from '../../src/types.js';

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1', projectId: 'p1', scope: 'global', pattern: null,
    content: 'Always use immutable patterns', severity: 'should',
    metadata: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(id: string, daysAgo = 0): { session: Session; events: SessionEvent[] } {
  const endedAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return {
    session: {
      id, projectId: 'p1', goal: 'test', summary: null,
      toolCalls: 5, entitiesModified: 1,
      startedAt: endedAt, endedAt,
    },
    events: [
      {
        id: `e-${id}`, sessionId: id, type: 'tool_call' as const,
        content: 'edit file', toolName: 'Edit', metadata: null,
        createdAt: endedAt,
      },
    ],
  };
}

function makeMockStore(rules: Rule[]): KnowledgeStore {
  return {
    listRules: vi.fn().mockReturnValue(rules),
    updateRule: vi.fn(),
  } as unknown as KnowledgeStore;
}

function makeMockLearningStore(pendingCount = 0): LearningStore {
  return {
    countPendingProposals: vi.fn().mockReturnValue(pendingCount),
    listProposals: vi.fn().mockReturnValue([]),
    addProposal: vi.fn().mockImplementation(params => ({
      id: 'prop-1', ...params, status: 'pending',
      createdAt: new Date().toISOString(), resolvedAt: null,
    })),
  } as unknown as LearningStore;
}

describe('computeObservance', () => {
  it('should return score 1.0 for fully conformant sessions', () => {
    const rule = makeRule();
    const sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s${i}`, i));

    const result = computeObservance(rule, sessions);
    expect(result.score).toBeGreaterThan(0.9);
    expect(result.sampleSize).toBe(10);
    expect(result.conformSessions).toBe(10);
  });

  it('should return score 0 for fully non-conformant sessions', () => {
    const rule = makeRule();
    // All sessions have reverts
    const sessions = Array.from({ length: 10 }, (_, i) => {
      const s = makeSession(`s${i}`, i);
      s.events = [{
        id: `e-${i}`, sessionId: `s${i}`, type: 'tool_call' as const,
        content: 'git.revert: oops', toolName: 'git', metadata: null,
        createdAt: new Date().toISOString(),
      }];
      return s;
    });

    const result = computeObservance(rule, sessions);
    expect(result.score).toBe(0);
    expect(result.conformSessions).toBe(0);
  });

  it('should return 0 for no relevant sessions', () => {
    const rule = makeRule({ scope: 'file_pattern', pattern: '*.rs' });
    // No sessions have Rust files
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession(`s${i}`, i));

    const result = computeObservance(rule, sessions);
    expect(result.sampleSize).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe('evaluateRules', () => {
  it('should not propose anything with < 10 sessions', () => {
    const store = makeMockStore([makeRule()]);
    const learningStore = makeMockLearningStore();
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession(`s${i}`, i));

    const proposals = evaluateRules('p1', store, learningStore, sessions);
    expect(proposals).toHaveLength(0);
  });

  it('should propose promotion for consistently followed should rule', () => {
    const rule = makeRule({ severity: 'should' });
    const store = makeMockStore([rule]);
    const learningStore = makeMockLearningStore();
    // Need 20+ sessions for promotion
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(`s${i}`, i));

    const proposals = evaluateRules('p1', store, learningStore, sessions);
    // All sessions are clean (no reverts/bugs) → high observance → promotion
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const promotion = proposals[0];
    expect(promotion.proposedSeverity).toBe('must');
  });

  it('should propose demotion for poorly followed should rule', () => {
    const rule = makeRule({ severity: 'should' });
    const store = makeMockStore([rule]);
    const learningStore = makeMockLearningStore();
    // Make all sessions non-conformant (with reverts)
    const sessions = Array.from({ length: 15 }, (_, i) => {
      const s = makeSession(`s${i}`, i);
      s.events = [{
        id: `e-${i}`, sessionId: `s${i}`, type: 'tool_call' as const,
        content: 'git.revert: mistake', toolName: 'git', metadata: null,
        createdAt: new Date().toISOString(),
      }];
      return s;
    });

    const proposals = evaluateRules('p1', store, learningStore, sessions);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0].proposedSeverity).toBe('prefer');
  });

  it('should not exceed MAX_PENDING_RULE_PROPOSALS', () => {
    const store = makeMockStore([makeRule()]);
    const learningStore = makeMockLearningStore(20); // already at max
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(`s${i}`, i));

    const proposals = evaluateRules('p1', store, learningStore, sessions);
    expect(proposals).toHaveLength(0);
  });
});
