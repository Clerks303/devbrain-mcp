import { describe, it, expect } from 'vitest';
import { validateLessons, isLessonActive, computeForgetConfidence } from '../../src/learning/feedback-loop.js';
import type { GeneratedLesson } from '../../src/learning/types.js';

function makeLesson(overrides: Partial<GeneratedLesson> = {}): GeneratedLesson {
  return {
    trigger: 'When modifying auth module',
    action: 'Always run auth tests',
    outcome: 'positive',
    confidence: 0.5,
    source: 'auto',
    ...overrides,
  };
}

describe('validateLessons', () => {
  it('should accept lessons with sufficient confidence', () => {
    const lessons = [makeLesson({ confidence: 0.5 })];
    const { accepted, rejected } = validateLessons(lessons, true);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('should reject lessons with confidence < 0.3', () => {
    const lessons = [makeLesson({ confidence: 0.2 })];
    const { accepted, rejected } = validateLessons(lessons, true);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('confidence too low');
  });

  it('should reduce confidence if session has no summary', () => {
    const lessons = [makeLesson({ confidence: 0.35 })];
    // 0.35 × 0.8 = 0.28 → below 0.3 threshold
    const { accepted, rejected } = validateLessons(lessons, false);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it('should accept lessons above threshold even without summary', () => {
    const lessons = [makeLesson({ confidence: 0.5 })];
    // 0.5 × 0.8 = 0.4 → above 0.3 threshold
    const { accepted } = validateLessons(lessons, false);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].confidence).toBeCloseTo(0.4);
  });

  it('should reject empty trigger or action', () => {
    const lessons = [
      makeLesson({ trigger: '', action: 'do something' }),
      makeLesson({ trigger: 'when something', action: '' }),
    ];
    const { accepted, rejected } = validateLessons(lessons, true);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });

  it('should reject very short combined content', () => {
    const lessons = [makeLesson({ trigger: 'ab', action: 'cd' })];
    const { accepted, rejected } = validateLessons(lessons, true);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toContain('too short');
  });
});

describe('isLessonActive', () => {
  it('should return true when occurrences >= 2 and confidence >= 0.4', () => {
    expect(isLessonActive(2, 0.5)).toBe(true);
    expect(isLessonActive(3, 0.4)).toBe(true);
  });

  it('should return false when in quarantine (occurrences < 2)', () => {
    expect(isLessonActive(1, 0.8)).toBe(false);
    expect(isLessonActive(0, 0.9)).toBe(false);
  });

  it('should return false when confidence below threshold', () => {
    expect(isLessonActive(5, 0.3)).toBe(false);
    expect(isLessonActive(10, 0.1)).toBe(false);
  });
});

describe('computeForgetConfidence', () => {
  it('should return 0.1 (below injection threshold)', () => {
    expect(computeForgetConfidence()).toBe(0.1);
    expect(computeForgetConfidence()).toBeLessThan(0.4);
  });
});
