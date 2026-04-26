import { describe, it, expect } from 'vitest';
import {
  extractActionNgrams,
  canonicalizeNgram,
  patternSignature,
  extractFileCooccurrences,
  extractErrorFileAssociations,
  extractPatterns,
} from '../../src/learning/pattern-extractor.js';
import type { SessionEvent, Session } from '../../src/types.js';

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2, 8),
    sessionId: 's1',
    type: 'tool_call',
    content: '',
    toolName: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeToolEvent(toolName: string, metadata?: Record<string, unknown>): SessionEvent {
  return makeEvent({ type: 'tool_call', toolName, content: `Called ${toolName}`, metadata: metadata ?? null });
}

describe('extractActionNgrams', () => {
  it('should extract 3-grams from tool names', () => {
    const events = [
      makeToolEvent('Read'),
      makeToolEvent('Edit'),
      makeToolEvent('Write'),
      makeToolEvent('Read'),
      makeToolEvent('Edit'),
      makeToolEvent('Write'),
    ];

    const ngrams = extractActionNgrams(events, 3);
    expect(ngrams.size).toBeGreaterThan(0);
    expect(ngrams.get('Read → Edit → Write')).toBe(2);
  });

  it('should ignore non-tool-call events', () => {
    const events = [
      makeEvent({ type: 'error', content: 'some error' }),
      makeToolEvent('Read'),
      makeEvent({ type: 'decision', content: 'decided something' }),
      makeToolEvent('Edit'),
    ];

    const ngrams = extractActionNgrams(events, 3);
    expect(ngrams.size).toBe(0); // only 2 tool calls, not enough for 3-gram
  });

  it('should return empty map for fewer events than window', () => {
    const events = [makeToolEvent('Read'), makeToolEvent('Edit')];
    const ngrams = extractActionNgrams(events, 3);
    expect(ngrams.size).toBe(0);
  });
});

describe('canonicalizeNgram', () => {
  it('should strip arguments from tool names', () => {
    const result = canonicalizeNgram(['devbrain_digest_file:src/auth.ts', 'Edit:src/foo.ts', 'Read']);
    expect(result).toBe('devbrain_digest_file:ARG → Edit:ARG → Read');
  });

  it('should keep names without arguments unchanged', () => {
    const result = canonicalizeNgram(['Read', 'Edit', 'Write']);
    expect(result).toBe('Read → Edit → Write');
  });
});

describe('patternSignature', () => {
  it('should return a 16-char hex hash', () => {
    const sig = patternSignature('Read → Edit → Write');
    expect(sig).toHaveLength(16);
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should be deterministic', () => {
    const sig1 = patternSignature('Read → Edit → Write');
    const sig2 = patternSignature('Read → Edit → Write');
    expect(sig1).toBe(sig2);
  });

  it('should differ for different inputs', () => {
    const sig1 = patternSignature('Read → Edit → Write');
    const sig2 = patternSignature('Write → Edit → Read');
    expect(sig1).not.toBe(sig2);
  });
});

describe('extractFileCooccurrences', () => {
  it('should count file pairs across sessions', () => {
    const sessions = [
      [makeToolEvent('Edit', { file_path: 'a.ts' }), makeToolEvent('Edit', { file_path: 'b.ts' })],
      [makeToolEvent('Edit', { file_path: 'a.ts' }), makeToolEvent('Edit', { file_path: 'b.ts' })],
      [makeToolEvent('Edit', { file_path: 'a.ts' }), makeToolEvent('Edit', { file_path: 'b.ts' })],
    ];

    const cooc = extractFileCooccurrences(sessions);
    expect(cooc.get('a.ts ↔ b.ts')).toBe(3);
  });

  it('should handle sessions without file metadata', () => {
    const sessions = [[makeToolEvent('Read'), makeToolEvent('Edit')]];
    const cooc = extractFileCooccurrences(sessions);
    expect(cooc.size).toBe(0);
  });
});

describe('extractErrorFileAssociations', () => {
  it('should associate files near error events', () => {
    const events = [
      makeToolEvent('Edit', { file_path: 'auth.ts' }),
      makeEvent({ type: 'error', content: 'TypeError', metadata: null }),
      makeToolEvent('Edit', { file_path: 'auth.ts' }),
    ];

    const associations = extractErrorFileAssociations(events);
    expect(associations.get('auth.ts ↔ error')).toBe(2);
  });

  it('should return empty for sessions without errors', () => {
    const events = [
      makeToolEvent('Edit', { file_path: 'foo.ts' }),
      makeToolEvent('Read'),
    ];
    const associations = extractErrorFileAssociations(events);
    expect(associations.size).toBe(0);
  });
});

describe('extractPatterns', () => {
  it('should detect action sequences repeated across sessions', () => {
    const session: Session = {
      id: 's-current', projectId: 'p1', goal: 'test', summary: null,
      toolCalls: 10, entitiesModified: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    };

    const events = [
      makeToolEvent('Read'), makeToolEvent('Edit'), makeToolEvent('Write'),
    ];

    // Same pattern in 3 past sessions (need minOccurrences = 3 sessions)
    const recentSessions = Array.from({ length: 3 }, (_, i) => ({
      sessionId: `s-${i}`,
      events: [makeToolEvent('Read'), makeToolEvent('Edit'), makeToolEvent('Write')],
    }));

    const patterns = extractPatterns(session, events, recentSessions, 3);
    const actionPatterns = patterns.filter(p => p.type === 'action_sequence');
    expect(actionPatterns.length).toBeGreaterThan(0);
  });

  it('should not detect patterns below threshold', () => {
    const session: Session = {
      id: 's-current', projectId: 'p1', goal: 'test', summary: null,
      toolCalls: 3, entitiesModified: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    };

    const events = [makeToolEvent('Read'), makeToolEvent('Edit'), makeToolEvent('Write')];

    // Only 1 past session — below minOccurrences=3
    const recentSessions = [{
      sessionId: 's-0',
      events: [makeToolEvent('Read'), makeToolEvent('Edit'), makeToolEvent('Write')],
    }];

    const patterns = extractPatterns(session, events, recentSessions, 3);
    const actionPatterns = patterns.filter(p => p.type === 'action_sequence');
    // Current + 1 recent = 2 sessions, below threshold of 3
    expect(actionPatterns).toHaveLength(0);
  });

  it('should detect file co-occurrences above threshold', () => {
    const session: Session = {
      id: 's-current', projectId: 'p1', goal: 'test', summary: null,
      toolCalls: 5, entitiesModified: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    };

    const events = [
      makeToolEvent('Edit', { file_path: 'a.ts' }),
      makeToolEvent('Edit', { file_path: 'b.ts' }),
    ];

    const recentSessions = Array.from({ length: 3 }, (_, i) => ({
      sessionId: `s-${i}`,
      events: [
        makeToolEvent('Edit', { file_path: 'a.ts' }),
        makeToolEvent('Edit', { file_path: 'b.ts' }),
      ],
    }));

    const patterns = extractPatterns(session, events, recentSessions, 3);
    const coocPatterns = patterns.filter(p => p.type === 'file_cooccurrence');
    expect(coocPatterns.length).toBeGreaterThan(0);
  });
});
