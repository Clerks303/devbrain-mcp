import { describe, it, expect, vi } from 'vitest';
import { generateLessons } from '../../src/learning/lesson-generator.js';
import type { Session, SessionEvent } from '../../src/types.js';
import type { KnowledgeStore } from '../../src/db/store.js';
import type { VectorStore } from '../../src/db/vector.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', projectId: 'p1', goal: 'test session', summary: null,
    toolCalls: 10, entitiesModified: 2,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    sessionId: 's1', type: 'tool_call', content: '', toolName: null,
    metadata: null, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockStore(): KnowledgeStore {
  return {
    listIssues: vi.fn().mockReturnValue([]),
    getLesson: vi.fn().mockReturnValue(null),
    reinforceLesson: vi.fn(),
    addLesson: vi.fn(),
  } as unknown as KnowledgeStore;
}

function mockVectorStore(): VectorStore {
  return {
    searchLessons: vi.fn().mockReturnValue([]),
  } as unknown as VectorStore;
}

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    dimension: 3,
    providerName: 'test',
  } as unknown as EmbeddingProvider;
}

describe('generateLessons', () => {
  it('should generate a negative lesson from a git revert event', async () => {
    const session = makeSession();
    const events = [
      makeEvent({ type: 'tool_call', content: 'git.revert: reverted commit abc123', metadata: { file_path: 'src/auth.ts' } }),
    ];

    const result = await generateLessons(session, events, mockStore(), mockVectorStore(), mockEmbeddingProvider());
    expect(result.lessons.length).toBeGreaterThanOrEqual(1);
    const revertLesson = result.lessons.find(l => l.outcome === 'negative');
    expect(revertLesson).toBeDefined();
    expect(revertLesson!.source).toBe('auto');
  });

  it('should generate a negative lesson from build failure → success', async () => {
    const session = makeSession();
    const events = [
      makeEvent({ type: 'tool_call', content: 'edit file', metadata: { file_path: 'src/index.ts' } }),
      makeEvent({ type: 'error', content: 'build_failure: compilation error' }),
      makeEvent({ type: 'tool_call', content: 'fix issue' }),
      makeEvent({ type: 'tool_call', content: 'build_success: build passed' }),
    ];

    const result = await generateLessons(session, events, mockStore(), mockVectorStore(), mockEmbeddingProvider());
    const buildLesson = result.lessons.find(l => l.trigger.includes('Build failed'));
    expect(buildLesson).toBeDefined();
    expect(buildLesson!.outcome).toBe('negative');
  });

  it('should not generate more than MAX_AUTO_LESSONS_PER_SESSION', async () => {
    const session = makeSession();
    // Create many revert events
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({
        type: 'tool_call',
        content: `git.revert: revert ${i}`,
        metadata: { file_path: `file${i}.ts` },
      })
    );

    const result = await generateLessons(session, events, mockStore(), mockVectorStore(), mockEmbeddingProvider());
    expect(result.lessons.length).toBeLessThanOrEqual(5);
  });

  it('should return empty lessons for clean session', async () => {
    const session = makeSession();
    const events = [
      makeEvent({ type: 'tool_call', content: 'Read file', toolName: 'Read' }),
      makeEvent({ type: 'tool_call', content: 'Edit file', toolName: 'Edit' }),
      makeEvent({ type: 'decision', content: 'Decided to refactor' }),
    ];

    const result = await generateLessons(session, events, mockStore(), mockVectorStore(), mockEmbeddingProvider());
    expect(result.lessons).toHaveLength(0);
    expect(result.deduped).toBe(0);
    expect(result.contradictions).toBe(0);
  });
});
