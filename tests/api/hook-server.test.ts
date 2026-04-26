import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHookServer, type HookServer } from '../../src/api/hook-server.js';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import { DevBrain } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

function createNoopEmbedding(): EmbeddingProvider {
  return {
    dimension: 4,
    async embed() { return [0, 0, 0, 0]; },
  };
}

function createTestBrain(): { brain: DevBrain; cleanup: () => void } {
  const config = { ...loadConfig(), dbPath: ':memory:' };
  const embeddingProvider = createNoopEmbedding();
  const db = initDatabase(':memory:', 4);
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);
  const brain = new DevBrain(store, vectorStore, embeddingProvider, config);
  return { brain, cleanup: () => db.close() };
}

async function httpRequest(
  port: number,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

describe('HookServer', { sequential: true }, () => {
  let brain: DevBrain;
  let hookServer: HookServer;
  let cleanup: () => void;
  let testPort = 17384;

  beforeEach(async () => {
    testPort++;
    ({ brain, cleanup } = createTestBrain());
    hookServer = createHookServer(brain, testPort);
    await hookServer.listen();
  });

  afterEach(async () => {
    await hookServer.close();
    cleanup();
    // Small delay to allow port release
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const { status, body } = await httpRequest(testPort, '/health');
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
      expect(body.activeProject).toBeNull();
      expect(body.activeSession).toBeNull();
    });
  });

  describe('POST /api/hook/session-start', () => {
    it('should return error when no cwd provided', async () => {
      const { status, body } = await httpRequest(testPort, '/api/hook/session-start', {
        method: 'POST',
        body: {},
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.error).toContain('Missing cwd');
    });

    it('should return error when no project matches cwd', async () => {
      const { status, body } = await httpRequest(testPort, '/api/hook/session-start', {
        method: 'POST',
        body: { cwd: '/nonexistent/path' },
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.error).toContain('No registered project');
    });

    it('should start session for registered project', async () => {
      // Register a project
      brain.store.addProject({ name: 'test-project', path: '/tmp/test-project' });

      const { status, body } = await httpRequest(testPort, '/api/hook/session-start', {
        method: 'POST',
        body: { cwd: '/tmp/test-project' },
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.projectName).toBe('test-project');
      expect(body.sessionId).toBeTruthy();
      expect(brain.activeProjectId).toBeTruthy();
      expect(brain.activeSessionId).toBeTruthy();
    });

    it('should be idempotent — second call returns existing session', async () => {
      brain.store.addProject({ name: 'test-project', path: '/tmp/test-project' });

      const first = await httpRequest(testPort, '/api/hook/session-start', {
        method: 'POST',
        body: { cwd: '/tmp/test-project' },
      });
      const second = await httpRequest(testPort, '/api/hook/session-start', {
        method: 'POST',
        body: { cwd: '/tmp/test-project' },
      });

      expect(first.body.sessionId).toBe(second.body.sessionId);
    });

    it('should detect project from subdirectory', async () => {
      brain.store.addProject({ name: 'nested-project', path: '/tmp/nested-project' });

      const { body } = await httpRequest(testPort, '/api/hook/session-start', {
        method: 'POST',
        body: { cwd: '/tmp/nested-project/src/deep/nested' },
      });
      expect(body.ok).toBe(true);
      expect(body.projectName).toBe('nested-project');
    });
  });

  describe('POST /api/hook/post-tool', () => {
    it('should return error when no tool_name', async () => {
      const { body } = await httpRequest(testPort, '/api/hook/post-tool', {
        method: 'POST',
        body: {},
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain('Missing tool_name');
    });

    it('should ignore read-only tools', async () => {
      const { body } = await httpRequest(testPort, '/api/hook/post-tool', {
        method: 'POST',
        body: { tool_name: 'Read' },
      });
      expect(body.ok).toBe(true);
      expect(body.action).toBe('ignored');
    });

    it('should return no_session when no active session', async () => {
      const { body } = await httpRequest(testPort, '/api/hook/post-tool', {
        method: 'POST',
        body: { tool_name: 'Write', tool_input: { file_path: '/tmp/file.ts' } },
      });
      expect(body.ok).toBe(true);
      expect(body.action).toBe('no_session');
    });

    it('should log tool call and digest file for Write', async () => {
      // Setup: create project and session
      const project = brain.store.addProject({ name: 'test', path: '/tmp/test' });
      brain.activeProjectId = project.id;
      const session = brain.store.startSession({ projectId: project.id, goal: 'test' });
      brain.activeSessionId = session.id;

      const { body } = await httpRequest(testPort, '/api/hook/post-tool', {
        method: 'POST',
        body: {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/test/src/index.ts' },
        },
      });
      expect(body.ok).toBe(true);
      expect(body.action).toBe('digested');

      // Verify event was logged
      const events = brain.store.getSessionEvents(session.id);
      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe('Write');
    });
  });

  describe('POST /api/hook/session-end', () => {
    it('should return error when no active session and no current.json', async () => {
      // Ensure no active session in brain
      brain.activeSessionId = null;

      // Remove current.json if it exists from previous runs
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const currentPath = path.join(os.homedir(), '.devbrain', 'sessions', 'current.json');
      try { fs.unlinkSync(currentPath); } catch { /* ignore */ }

      const { body } = await httpRequest(testPort, '/api/hook/session-end', {
        method: 'POST',
        body: {},
      });
      expect(body.ok).toBe(false);
      expect(body.error).toBeTruthy();
    });

    it('should end active session with summary', async () => {
      const project = brain.store.addProject({ name: 'test', path: '/tmp/test' });
      brain.activeProjectId = project.id;
      const session = brain.store.startSession({ projectId: project.id, goal: 'Implement feature X' });
      brain.activeSessionId = session.id;

      // Add some events
      brain.store.addSessionEvent({ sessionId: session.id, type: 'tool_call', content: 'Write', toolName: 'Write' });
      brain.store.addSessionEvent({ sessionId: session.id, type: 'decision', content: 'Use factory pattern', toolName: null });

      const { body } = await httpRequest(testPort, '/api/hook/session-end', {
        method: 'POST',
        body: { session_id: session.id },
      });
      expect(body.ok).toBe(true);
      expect(body.sessionId).toBe(session.id);
      expect(body.summary).toContain('Implement feature X');
      expect(body.summary).toContain('Write');
      expect(brain.activeSessionId).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return 405 for non-POST on API routes', async () => {
      const { status, body } = await httpRequest(testPort, '/api/hook/session-start');
      expect(status).toBe(405);
      expect(body.error).toBe('Method not allowed');
    });

    it('should return 404 for unknown routes', async () => {
      const { status, body } = await httpRequest(testPort, '/unknown', {
        method: 'POST',
        body: {},
      });
      expect(status).toBe(404);
      expect(body.error).toBe('Not found');
    });

    it('should return 400 for invalid JSON', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/hook/session-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      const body = await res.json() as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid JSON body');
    });
  });
});
