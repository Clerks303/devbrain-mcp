/** Types for the Context Injector pipeline */

export type PromptIntent = 'implement' | 'refactor' | 'debug' | 'review' | 'architecture' | 'generic';

export interface PromptAnalysis {
  readonly rawPrompt: string;
  readonly intent: PromptIntent;
  readonly mentionedFiles: string[];
  readonly mentionedIdentifiers: string[];
  readonly keywords: string[];
  readonly language: 'fr' | 'en' | 'mixed';
  readonly confidence: number; // 0-1, < 0.3 = trivial, skip injection
}

export interface FetchedContext {
  readonly entities: FetchedEntity[];
  readonly rules: FetchedRule[];
  readonly lessons: FetchedLesson[];
  readonly openIssues: FetchedIssue[];
  readonly lastSession: FetchedSession | null;
  readonly neighbors: FetchedEntity[];
}

export interface FetchedEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: string | null;
  readonly status: string;
  readonly source: 'fts' | 'vector' | 'name_match';
}

export interface FetchedRule {
  readonly id: string;
  readonly content: string;
  readonly severity: 'must' | 'should' | 'prefer';
  readonly scope: string;
  readonly pattern: string | null;
}

export interface FetchedLesson {
  readonly id: string;
  readonly trigger: string;
  readonly action: string;
  readonly outcome: 'positive' | 'negative' | 'neutral';
  readonly confidence: number;
}

export interface FetchedIssue {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly type: string;
}

export interface FetchedSession {
  readonly goal: string;
  readonly summary: string | null;
  readonly endedAt: string | null;
}

export interface ScoredItem {
  readonly category: 'rule' | 'entity' | 'lesson' | 'issue' | 'session' | 'neighbor';
  readonly score: number;
  readonly text: string;
  readonly id: string;
}

export interface TokenBudgetAllocation {
  readonly rules: ScoredItem[];
  readonly session: ScoredItem[];
  readonly entities: ScoredItem[];
  readonly lessons: ScoredItem[];
  readonly issues: ScoredItem[];
  readonly neighbors: ScoredItem[];
  readonly totalTokens: number;
}
