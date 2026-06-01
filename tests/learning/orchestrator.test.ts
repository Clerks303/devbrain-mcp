import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import { LearningOrchestrator } from '../../src/learning/index.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';
import path from 'node:path';
import os from 'node:os';

function createTestDb() {
  const dbPath = path.join(os.tmpdir(), `devbrain-test-orch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(dbPath, 3);
  return { db, dbPath };
}

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: async () => [0.1, 0.2, 0.3],
    dimension: 3,
    providerName: 'test',
  } as unknown as EmbeddingProvider;
}

describe('LearningOrchestrator', () => {
  let store: KnowledgeStore;
  let vectorStore: VectorStore;
  let orchestrator: LearningOrchestrator;

  beforeEach(() => {
    const { db } = createTestDb();
    store = new KnowledgeStore(db);
    vectorStore = new VectorStore(db);
    orchestrator = new LearningOrchestrator(store, vectorStore, mockEmbeddingProvider());
  });

  it('should return error report for non-existent session', async () => {
    const report = await orchestrator.processSession('nonexistent', 'p1');
    expect(report.errors).toContain('Session not found or not ended');
    expect(report.lessonsGenerated).toBe(0);
  });

  it('should return error report for session not yet ended', async () => {
    const project = store.addProject({ name: 'Test', path: '/tmp/test' });
    const session = store.startSession({ projectId: project.id, goal: 'test' });

    const report = await orchestrator.processSession(session.id, project.id);
    expect(report.errors).toContain('Session not found or not ended');
  });

  it('should process a completed session successfully', async () => {
    const project = store.addProject({ name: 'Test', path: '/tmp/test' });
    const session = store.startSession({ projectId: project.id, goal: 'test goal' });

    // Add some events
    store.addSessionEvent({ sessionId: session.id, type: 'tool_call', content: 'Read file', toolName: 'Read' });
    store.addSessionEvent({ sessionId: session.id, type: 'tool_call', content: 'Edit file', toolName: 'Edit' });
    store.addSessionEvent({ sessionId: session.id, type: 'decision', content: 'Decided to refactor auth' });

    // End session
    store.endSession(session.id, 'Refactored auth module');

    const report = await orchestrator.processSession(session.id, project.id);

    expect(report.sessionId).toBe(session.id);
    expect(report.projectId).toBe(project.id);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.errors).toHaveLength(0);
  });

  it('should be idempotent — running twice produces consistent results', async () => {
    const project = store.addProject({ name: 'Test', path: '/tmp/test' });
    const session = store.startSession({ projectId: project.id, goal: 'test' });
    store.addSessionEvent({ sessionId: session.id, type: 'tool_call', content: 'Edit file', toolName: 'Edit' });
    store.endSession(session.id, 'Done');

    const report1 = await orchestrator.processSession(session.id, project.id);
    const report2 = await orchestrator.processSession(session.id, project.id);

    // Second run should not generate additional lessons (no new event patterns)
    expect(report2.lessonsGenerated).toBe(report1.lessonsGenerated);
  });

  it('should complete in reasonable time', async () => {
    const project = store.addProject({ name: 'Test', path: '/tmp/test' });
    const session = store.startSession({ projectId: project.id, goal: 'perf test' });

    // Add 100 events
    for (let i = 0; i < 100; i++) {
      store.addSessionEvent({
        sessionId: session.id,
        type: 'tool_call',
        content: `action ${i}`,
        toolName: i % 3 === 0 ? 'Read' : i % 3 === 1 ? 'Edit' : 'Write',
      });
    }
    store.endSession(session.id, 'Done');

    const start = Date.now();
    const report = await orchestrator.processSession(session.id, project.id);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000); // < 2s (generous for CI)
    expect(report.errors).toHaveLength(0);
  });

  it('should detect patterns and generate lessons from revert events', async () => {
    const project = store.addProject({ name: 'Test', path: '/tmp/test' });
    const session = store.startSession({ projectId: project.id, goal: 'bugfix' });

    store.addSessionEvent({
      sessionId: session.id, type: 'tool_call',
      content: 'git.revert: reverted bad commit',
      toolName: 'git',
      metadata: { file_path: 'src/auth.ts' },
    });
    store.endSession(session.id, 'Reverted bad change');

    const report = await orchestrator.processSession(session.id, project.id);
    expect(report.lessonsGenerated).toBeGreaterThanOrEqual(1);
  });
});
