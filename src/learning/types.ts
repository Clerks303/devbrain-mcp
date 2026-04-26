/** Types and constants for the Learning Engine */

export const LEARNING_SAFETY = {
  MIN_CONFIDENCE_FOR_INJECTION: 0.4,
  MIN_OCCURRENCES_FOR_ACTIVATION: 2,
  MIN_SESSIONS_FOR_RULE_EVOLUTION: 10,
  RULE_PROMOTION_THRESHOLD: 0.95,
  RULE_DEMOTION_THRESHOLD: 0.50,
  DEDUP_COSINE_THRESHOLD: 0.15,
  CONTRADICTION_COSINE_THRESHOLD: 0.20,
  MAX_AUTO_LESSONS_PER_SESSION: 5,
  MAX_PENDING_RULE_PROPOSALS: 20,
} as const;

export type PatternType = 'action_sequence' | 'file_cooccurrence' | 'error_file_association';

export interface LearningPattern {
  readonly id: string;
  readonly projectId: string;
  readonly type: PatternType;
  readonly signature: string;
  readonly description: string;
  readonly frequency: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly evidence: string[];  // session IDs
  readonly metadata: Record<string, unknown> | null;
}

export interface RuleProposal {
  readonly id: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly currentSeverity: string;
  readonly proposedSeverity: string;
  readonly reason: string;
  readonly observanceScore: number;
  readonly sampleSize: number;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface ContextFeedback {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly contextId: string;
  readonly contextType: string;
  readonly wasUseful: boolean;
  readonly score: number;
  readonly recordedAt: string;
}

export interface ContextScore {
  readonly id: string;
  readonly projectId: string;
  readonly contextId: string;
  readonly contextType: string;
  readonly usefulnessScore: number;
  readonly feedbackCount: number;
  readonly lastUpdatedAt: string;
}

export interface DeveloperProfile {
  readonly primaryLanguages: string[];
  readonly frequentlyEditedFilePatterns: string[];
  readonly avgSessionDurationMinutes: number;
  readonly avgToolCallsPerSession: number;
  readonly avgEntitiesModifiedPerSession: number;
  readonly frequentIssueTypes: Array<{ type: string; count: number; resolvedRate: number }>;
  readonly issueProneFilePatterns: string[];
  readonly tendencies: Array<{ description: string; confidence: number }>;
  readonly lastUpdatedAt: string;
  readonly sessionCount: number;
}

export interface LearningReport {
  readonly sessionId: string;
  readonly projectId: string;
  readonly patternsDetected: number;
  readonly lessonsGenerated: number;
  readonly lessonsDeduped: number;
  readonly contradictionsDetected: number;
  readonly ruleProposalsPending: number;
  readonly contextScoresUpdated: number;
  readonly profileUpdated: boolean;
  readonly durationMs: number;
  readonly errors: string[];
}

export interface ExtractedPattern {
  readonly type: PatternType;
  readonly signature: string;
  readonly description: string;
  readonly evidence: string[];
}

export interface GeneratedLesson {
  readonly trigger: string;
  readonly action: string;
  readonly outcome: 'positive' | 'negative';
  readonly confidence: number;
  readonly source: 'auto';
}
