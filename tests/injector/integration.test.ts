import { describe, it, expect } from 'vitest';
import { analyzePrompt } from '../../src/injector/prompt-analyzer.js';
import { scoreContext } from '../../src/injector/relevance-scorer.js';
import { allocateBudget } from '../../src/injector/token-budget.js';
import { formatContext, formatRulesFile } from '../../src/injector/context-formatter.js';
import type { FetchedContext, PromptAnalysis, ScoredItem } from '../../src/injector/types.js';

/** Build a mock FetchedContext for testing */
function mockContext(): FetchedContext {
  return {
    entities: [
      { id: 'e1', name: 'AuthService', type: 'service', content: 'JWT authentication service', status: 'active', source: 'name_match' },
      { id: 'e2', name: 'UserRepository', type: 'repository', content: 'User data access layer', status: 'active', source: 'fts' },
      { id: 'e3', name: 'OldLogger', type: 'module', content: 'Deprecated logger', status: 'deprecated', source: 'fts' },
    ],
    rules: [
      { id: 'r1', content: 'Never mutate objects — always return new copies', severity: 'must', scope: 'global', pattern: null },
      { id: 'r2', content: 'Files must stay under 800 lines', severity: 'should', scope: 'global', pattern: null },
      { id: 'r3', content: 'Use arrow functions for callbacks', severity: 'prefer', scope: 'file_pattern', pattern: '*.ts' },
    ],
    lessons: [
      { id: 'l1', trigger: 'Adding OAuth provider', action: 'Create a dedicated adapter', outcome: 'positive', confidence: 0.8 },
      { id: 'l2', trigger: 'Extending AuthService directly', action: 'Tests become fragile', outcome: 'negative', confidence: 0.9 },
    ],
    openIssues: [
      { id: 'i1', title: 'Refresh token not invalidated on logout', severity: 'high', type: 'bug' },
      { id: 'i2', title: 'No rate limiting on /auth/login', severity: 'medium', type: 'security' },
    ],
    lastSession: {
      goal: 'Implement JWT flow',
      summary: 'JWT implemented with RS256, refresh token in Redis',
      endedAt: '2026-03-28T18:00:00Z',
    },
    neighbors: [
      { id: 'n1', name: 'RedisSessionStore', type: 'module', content: null, status: 'active', source: 'name_match' },
    ],
  };
}

describe('injector integration pipeline', () => {
  it('should run the full pipeline: analyze → score → budget → format', () => {
    const analysis = analyzePrompt('Refactore le AuthService pour extraire le JwtStrategy');
    expect(analysis.intent).toBe('refactor');
    expect(analysis.mentionedIdentifiers).toContain('AuthService');
    expect(analysis.mentionedIdentifiers).toContain('JwtStrategy');

    const context = mockContext();
    const scored = scoreContext(analysis, context);
    expect(scored.length).toBeGreaterThan(0);

    // AuthService should be boosted (name mentioned + type match for refactor)
    const authItem = scored.find(s => s.id === 'e1');
    expect(authItem).toBeDefined();
    expect(authItem!.score).toBeGreaterThan(0.8);

    // OldLogger should be penalized (deprecated) — score reduced by 0.30
    const oldLoggerItem = scored.find(s => s.id === 'e3');
    expect(oldLoggerItem).toBeDefined();
    expect(oldLoggerItem!.score).toBeLessThan(authItem!.score);

    const allocation = allocateBudget(scored);
    expect(allocation.totalTokens).toBeLessThanOrEqual(1800);
    expect(allocation.rules.length).toBeGreaterThan(0);
    expect(allocation.entities.length).toBeGreaterThan(0);

    const formatted = formatContext(allocation, analysis);
    expect(formatted).toContain('DevBrain context for: refactor');
    expect(formatted).toContain('AuthService');
  });

  it('should skip injection for trivial prompts', () => {
    const analysis = analyzePrompt('ok');
    expect(analysis.confidence).toBeLessThan(0.3);
    // Pipeline should short-circuit here — no need to fetch/score/allocate
  });

  it('should handle empty context gracefully', () => {
    const analysis = analyzePrompt('Implement a new payment service');
    const emptyContext: FetchedContext = {
      entities: [],
      rules: [],
      lessons: [],
      openIssues: [],
      lastSession: null,
      neighbors: [],
    };

    const scored = scoreContext(analysis, emptyContext);
    expect(scored).toHaveLength(0);

    const allocation = allocateBudget(scored);
    expect(allocation.totalTokens).toBe(0);

    const formatted = formatContext(allocation, analysis);
    expect(formatted).toBe('');
  });

  it('should respect token budget across all categories', () => {
    const analysis = analyzePrompt('Implement the authentication service with all modules');
    const context = mockContext();
    const scored = scoreContext(analysis, context);
    const allocation = allocateBudget(scored);

    expect(allocation.totalTokens).toBeLessThanOrEqual(1800);
    expect(allocation.totalTokens).toBeGreaterThan(0);
  });

  it('should produce French labels for French prompts', () => {
    const analysis = analyzePrompt("Implémente le service d'authentification avec les patterns du projet");
    const context = mockContext();
    const scored = scoreContext(analysis, context);
    const allocation = allocateBudget(scored);
    const formatted = formatContext(allocation, analysis);

    expect(formatted).toContain('Conventions obligatoires');
  });

  it('should produce English labels for English prompts', () => {
    const analysis = analyzePrompt('Create a new service that handles user authentication');
    const context = mockContext();
    const scored = scoreContext(analysis, context);
    const allocation = allocateBudget(scored);
    const formatted = formatContext(allocation, analysis);

    expect(formatted).toContain('Mandatory project conventions');
  });
});

describe('formatContext', () => {
  it('should omit empty sections', () => {
    const analysis = analyzePrompt('Implement something new with modules');
    const allocation = {
      rules: [],
      session: [],
      entities: [{ category: 'entity' as const, score: 0.9, text: '**Foo** (module): bar', id: 'e1' }],
      lessons: [],
      issues: [],
      neighbors: [],
      totalTokens: 10,
    };

    const formatted = formatContext(allocation, analysis);
    expect(formatted).not.toContain('Mandatory project conventions');
    expect(formatted).not.toContain('Open issues');
    expect(formatted).toContain('Foo');
  });

  it('should format neighbors as comma-separated inline', () => {
    const analysis = analyzePrompt('Check the modules related to authentication');
    const allocation = {
      rules: [],
      session: [],
      entities: [],
      lessons: [],
      issues: [],
      neighbors: [
        { category: 'neighbor' as const, score: 0.5, text: 'RedisStore (module)', id: 'n1' },
        { category: 'neighbor' as const, score: 0.45, text: 'CacheLayer (module)', id: 'n2' },
      ],
      totalTokens: 10,
    };

    const formatted = formatContext(allocation, analysis);
    expect(formatted).toContain('RedisStore (module), CacheLayer (module)');
  });
});

describe('formatRulesFile', () => {
  it('should generate a valid rules file', () => {
    const rules: ScoredItem[] = [
      { category: 'rule', score: 1.0, text: '[MUST] Never mutate objects', id: 'r1' },
    ];
    const entities: ScoredItem[] = [
      { category: 'entity', score: 0.9, text: '**AuthService** (service): JWT auth', id: 'e1' },
    ];
    const session: ScoredItem[] = [
      { category: 'session', score: 0.65, text: 'Last session goal: Implement JWT', id: 's1' },
    ];

    const content = formatRulesFile('MyProject', rules, entities, session);
    expect(content).toContain('# DevBrain — MyProject');
    expect(content).toContain('Auto-generated');
    expect(content).toContain('Mandatory conventions');
    expect(content).toContain('Never mutate objects');
    expect(content).toContain('Key architecture elements');
    expect(content).toContain('AuthService');
    expect(content).toContain('Last session');
    expect(content).toContain('Implement JWT');
  });

  it('should handle empty sections', () => {
    const content = formatRulesFile('EmptyProject', [], [], []);
    expect(content).toContain('# DevBrain — EmptyProject');
    expect(content).not.toContain('Mandatory conventions');
    expect(content).not.toContain('Key architecture elements');
  });
});

describe('relevance scorer details', () => {
  it('should boost entities mentioned in prompt', () => {
    const analysis: PromptAnalysis = {
      rawPrompt: 'Fix the AuthService bug',
      intent: 'debug',
      mentionedFiles: [],
      mentionedIdentifiers: ['AuthService'],
      keywords: ['authservice'],
      language: 'en',
      confidence: 0.7,
    };

    const context = mockContext();
    const scored = scoreContext(analysis, context);
    const auth = scored.find(s => s.id === 'e1');
    const user = scored.find(s => s.id === 'e2');

    expect(auth).toBeDefined();
    expect(user).toBeDefined();
    // AuthService should score higher due to name mention boost
    expect(auth!.score).toBeGreaterThan(user!.score);
  });

  it('should penalize non-active entities', () => {
    const analysis: PromptAnalysis = {
      rawPrompt: 'Implement new logging module',
      intent: 'implement',
      mentionedFiles: [],
      mentionedIdentifiers: [],
      keywords: ['logging', 'module'],
      language: 'en',
      confidence: 0.6,
    };

    const context = mockContext();
    const scored = scoreContext(analysis, context);
    // OldLogger (deprecated) should have lower score than active entities
    const oldLogger = scored.find(s => s.id === 'e3');
    const activeEntity = scored.find(s => s.id === 'e1');
    expect(oldLogger).toBeDefined();
    expect(activeEntity).toBeDefined();
    expect(oldLogger!.score).toBeLessThan(activeEntity!.score);
  });

  it('should boost negative lessons', () => {
    const analysis: PromptAnalysis = {
      rawPrompt: 'Extend the auth service',
      intent: 'implement',
      mentionedFiles: [],
      mentionedIdentifiers: [],
      keywords: ['extend', 'auth', 'service'],
      language: 'en',
      confidence: 0.6,
    };

    const context = mockContext();
    const scored = scoreContext(analysis, context);
    const negativeLesson = scored.find(s => s.id === 'l2');
    const positiveLesson = scored.find(s => s.id === 'l1');

    expect(negativeLesson).toBeDefined();
    expect(positiveLesson).toBeDefined();
    // Negative lesson (0.9 * 1.2 = 1.08) > positive (0.8 * 1.0 = 0.8)
    expect(negativeLesson!.score).toBeGreaterThan(positiveLesson!.score);
  });

  it('should score issues by severity', () => {
    const analysis: PromptAnalysis = {
      rawPrompt: 'Check for security issues',
      intent: 'review',
      mentionedFiles: [],
      mentionedIdentifiers: [],
      keywords: ['security', 'issues'],
      language: 'en',
      confidence: 0.6,
    };

    const context = mockContext();
    const scored = scoreContext(analysis, context);
    const highIssue = scored.find(s => s.id === 'i1');
    const mediumIssue = scored.find(s => s.id === 'i2');

    expect(highIssue).toBeDefined();
    expect(mediumIssue).toBeDefined();
    expect(highIssue!.score).toBeGreaterThan(mediumIssue!.score);
  });
});
