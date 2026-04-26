import type { KnowledgeStore } from '../db/store.js';
import type { VectorStore } from '../db/vector.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Session, SessionEvent } from '../types.js';
import type { LearningReport } from './types.js';
import { LearningStore } from './learning-store.js';
import { extractPatterns } from './pattern-extractor.js';
import { generateLessons } from './lesson-generator.js';
import { evaluateRules } from './rule-evolver.js';
import { inferFeedback, updateContextScores } from './context-ranker.js';
import { updateProfile } from './developer-profile.js';
import { validateLessons } from './feedback-loop.js';

/**
 * Orchestrates all learning modules.
 * Triggered non-blockingly at each session end.
 */
export class LearningOrchestrator {
  readonly learningStore: LearningStore;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly vectorStore: VectorStore,
    private readonly embeddingProvider: EmbeddingProvider,
  ) {
    this.learningStore = new LearningStore(store.getDb());
  }

  /**
   * Process a completed session through all learning modules.
   * Runs pattern extraction, lesson generation, rule evolution, and context ranking in parallel.
   */
  async processSession(sessionId: string, projectId: string): Promise<LearningReport> {
    const start = Date.now();
    const errors: string[] = [];

    // Load session and events
    const session = this.store.getSession(sessionId);
    if (!session || !session.endedAt) {
      return emptyReport(sessionId, projectId, Date.now() - start, ['Session not found or not ended']);
    }

    const events = this.store.getSessionEvents(sessionId);

    // Load recent sessions for cross-session analysis
    const recentSessions = this.loadRecentSessions(projectId, sessionId, 10);

    // Run all modules in parallel
    const [patternResult, lessonResult, ruleResult, contextResult] = await Promise.allSettled([
      this.runPatternExtraction(session, events, recentSessions),
      this.runLessonGeneration(session, events),
      this.runRuleEvolution(projectId, recentSessions, session, events),
      this.runContextRanking(projectId, sessionId, events, session.toolCalls),
    ]);

    let patternsDetected = 0;
    let lessonsGenerated = 0;
    let lessonsDeduped = 0;
    let contradictionsDetected = 0;
    let ruleProposalsPending = 0;
    let contextScoresUpdated = 0;

    // Collect pattern results
    if (patternResult.status === 'fulfilled') {
      patternsDetected = patternResult.value;
    } else {
      errors.push(`PatternExtractor: ${String(patternResult.reason)}`);
    }

    // Collect lesson results
    if (lessonResult.status === 'fulfilled') {
      lessonsGenerated = lessonResult.value.generated;
      lessonsDeduped = lessonResult.value.deduped;
      contradictionsDetected = lessonResult.value.contradictions;
    } else {
      errors.push(`LessonGenerator: ${String(lessonResult.reason)}`);
    }

    // Collect rule results
    if (ruleResult.status === 'fulfilled') {
      ruleProposalsPending = ruleResult.value;
    } else {
      errors.push(`RuleEvolver: ${String(ruleResult.reason)}`);
    }

    // Collect context results
    if (contextResult.status === 'fulfilled') {
      contextScoresUpdated = contextResult.value;
    } else {
      errors.push(`ContextRanker: ${String(contextResult.reason)}`);
    }

    // Update developer profile (non-critical)
    let profileUpdated = false;
    try {
      const profile = updateProfile(projectId, session, events, this.store, this.learningStore);
      profileUpdated = profile !== null;
    } catch (err) {
      errors.push(`DeveloperProfile: ${String(err)}`);
    }

    return {
      sessionId,
      projectId,
      patternsDetected,
      lessonsGenerated,
      lessonsDeduped,
      contradictionsDetected,
      ruleProposalsPending,
      contextScoresUpdated,
      profileUpdated,
      durationMs: Date.now() - start,
      errors,
    };
  }

  private loadRecentSessions(
    projectId: string,
    excludeSessionId: string,
    count: number,
  ): Array<{ session: Session; events: readonly SessionEvent[] }> {
    const sessions = this.store.listSessions(projectId, count + 1);
    return sessions
      .filter(s => s.id !== excludeSessionId && s.endedAt !== null)
      .slice(0, count)
      .map(session => ({
        session,
        events: this.store.getSessionEvents(session.id),
      }));
  }

  private async runPatternExtraction(
    session: Session,
    events: readonly SessionEvent[],
    recentSessions: readonly { session: Session; events: readonly SessionEvent[] }[],
  ): Promise<number> {
    const recentSessionEvents = recentSessions.map(s => ({
      sessionId: s.session.id,
      events: s.events,
    }));

    const patterns = extractPatterns(session, events, recentSessionEvents);

    for (const pattern of patterns) {
      this.learningStore.upsertPattern({
        projectId: session.projectId,
        type: pattern.type,
        signature: pattern.signature,
        description: pattern.description,
        sessionId: session.id,
      });
    }

    return patterns.length;
  }

  private async runLessonGeneration(
    session: Session,
    events: readonly SessionEvent[],
  ): Promise<{ generated: number; deduped: number; contradictions: number }> {
    const { lessons, deduped, contradictions } = await generateLessons(
      session, events, this.store, this.vectorStore, this.embeddingProvider,
    );

    // Validate lessons
    const { accepted } = validateLessons(lessons, session.summary !== null);

    // Insert validated lessons
    for (const lesson of accepted) {
      const created = this.store.addLesson({
        projectId: session.projectId,
        trigger: lesson.trigger,
        action: lesson.action,
        outcome: lesson.outcome,
        metadata: { source: 'auto', generated_in_session: session.id },
      });

      // Embed for future dedup
      try {
        const embedding = await this.embeddingProvider.embed(`${lesson.trigger} ${lesson.action}`);
        this.vectorStore.upsertLessonEmbedding(created.id, embedding);
      } catch { /* non-critical */ }
    }

    return { generated: accepted.length, deduped, contradictions };
  }

  private async runRuleEvolution(
    projectId: string,
    recentSessions: readonly { session: Session; events: readonly SessionEvent[] }[],
    currentSession: Session,
    currentEvents: readonly SessionEvent[],
  ): Promise<number> {
    const allSessions = [
      { session: currentSession, events: currentEvents },
      ...recentSessions,
    ];

    const proposals = evaluateRules(projectId, this.store, this.learningStore, allSessions);
    return proposals.length;
  }

  private async runContextRanking(
    projectId: string,
    sessionId: string,
    events: readonly SessionEvent[],
    toolCalls: number,
  ): Promise<number> {
    // Infer feedback for any context that was injected
    // Context IDs would come from session metadata; for now, use entity IDs from events
    const contextIds = new Set<string>();
    const contextTypes = new Map<string, string>();

    for (const event of events) {
      if (event.metadata) {
        const meta = event.metadata as Record<string, unknown>;
        const entityId = meta.entity_id as string | undefined;
        if (entityId) {
          contextIds.add(entityId);
          contextTypes.set(entityId, 'entity');
        }
      }
    }

    if (contextIds.size === 0) return 0;

    const feedback = inferFeedback([...contextIds], events, toolCalls);
    return updateContextScores(projectId, sessionId, feedback, contextTypes, this.learningStore);
  }
}

function emptyReport(
  sessionId: string,
  projectId: string,
  durationMs: number,
  errors: string[],
): LearningReport {
  return {
    sessionId,
    projectId,
    patternsDetected: 0,
    lessonsGenerated: 0,
    lessonsDeduped: 0,
    contradictionsDetected: 0,
    ruleProposalsPending: 0,
    contextScoresUpdated: 0,
    profileUpdated: false,
    durationMs,
    errors,
  };
}
