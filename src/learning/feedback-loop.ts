import type { GeneratedLesson } from './types.js';
import { LEARNING_SAFETY } from './types.js';

export interface ValidationResult {
  readonly accepted: GeneratedLesson[];
  readonly rejected: Array<{ lesson: GeneratedLesson; reason: string }>;
}

/**
 * Validate generated lessons before insertion.
 * Applies confidence thresholds and quality checks.
 */
export function validateLessons(
  lessons: readonly GeneratedLesson[],
  sessionHasSummary: boolean,
): ValidationResult {
  const accepted: GeneratedLesson[] = [];
  const rejected: Array<{ lesson: GeneratedLesson; reason: string }> = [];

  for (const lesson of lessons) {
    let adjustedConfidence = lesson.confidence;

    // Reduce confidence if session has no summary (less reliable data)
    if (!sessionHasSummary) {
      adjustedConfidence *= 0.8;
    }

    // Reject if below minimum threshold
    if (adjustedConfidence < 0.3) {
      rejected.push({ lesson, reason: `confidence too low: ${adjustedConfidence.toFixed(2)}` });
      continue;
    }

    // Reject empty triggers or actions
    if (!lesson.trigger.trim() || !lesson.action.trim()) {
      rejected.push({ lesson, reason: 'empty trigger or action' });
      continue;
    }

    // Reject overly short lessons (< 10 chars combined)
    if (lesson.trigger.length + lesson.action.length < 10) {
      rejected.push({ lesson, reason: 'content too short' });
      continue;
    }

    accepted.push({
      ...lesson,
      confidence: adjustedConfidence,
    });
  }

  return { accepted, rejected };
}

/**
 * Check if an auto-generated lesson should be visible in context injection.
 * Quarantine: lessons with occurrences < MIN_OCCURRENCES_FOR_ACTIVATION are invisible.
 */
export function isLessonActive(occurrences: number, confidence: number): boolean {
  return (
    occurrences >= LEARNING_SAFETY.MIN_OCCURRENCES_FOR_ACTIVATION &&
    confidence >= LEARNING_SAFETY.MIN_CONFIDENCE_FOR_INJECTION
  );
}

/**
 * Apply "forget" operation: decay confidence to below injection threshold.
 * Does not delete — prevents re-learning the same mistake.
 */
export function computeForgetConfidence(): number {
  return 0.1; // Below MIN_CONFIDENCE_FOR_INJECTION (0.4)
}
