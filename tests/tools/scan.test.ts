import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import { scanProject } from '../../src/tools/scan.js';
import type { DevBrain } from '../../src/server.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

const DIM = 4;
const __filename = fileURLToPath(import.meta.url);
const FIXTURE = path.resolve(path.dirname(__filename), '..', 'fixtures', 'sample-project');

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = DIM;
  readonly name = 'fake';
  async embed(_text: string): Promise<number[]> { return [0.1, 0.2, 0.3, 0.4]; }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  }
}

function createBrain(): { brain: DevBrain; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-scan-test-'));
  const dbPath = path.join(tmp, 'test.db');
  const db = initDatabase(dbPath, DIM);
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);

  // Minimal DevBrain-shaped object — only the fields scanProject touches.
  const brain = {
    store,
    vectorStore,
    embeddingProvider: new FakeEmbeddingProvider(),
    activeProjectId: null as string | null,
    activeSessionId: null as string | null,
  } as unknown as DevBrain;

  return {
    brain,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('scanProject', () => {
  let ctx: ReturnType<typeof createBrain>;

  beforeEach(() => { ctx = createBrain(); });
  afterEach(() => ctx.cleanup());

  it('creates a project and scans source files', async () => {
    const result = await scanProject(ctx.brain, { projectPath: FIXTURE });

    expect(result.project_id).toBeDefined();
    expect(result.files_scanned).toBeGreaterThanOrEqual(7); // 6 TSX + 3 stores + 1 index + 1 README
    expect(result.digests_created).toBeGreaterThanOrEqual(7);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('excludes node_modules by default', async () => {
    await scanProject(ctx.brain, { projectPath: FIXTURE });
    const digests = ctx.brain.store.listFileDigests(ctx.brain.activeProjectId!);
    const nm = digests.filter(d => d.path.includes('node_modules'));
    expect(nm).toHaveLength(0);
  });

  it('is idempotent (second scan detects no changes)', async () => {
    const first = await scanProject(ctx.brain, { projectPath: FIXTURE });
    expect(first.digests_created).toBeGreaterThan(0);

    const second = await scanProject(ctx.brain, { projectPath: FIXTURE });
    expect(second.digests_created).toBe(0);
    expect(second.digests_updated).toBe(0);
    expect(second.files_scanned).toBe(first.files_scanned);
  });

  it('detects conventions (kebab-case tsx + -store suffix)', async () => {
    const result = await scanProject(ctx.brain, { projectPath: FIXTURE });
    expect(result.conventions_detected).toBeGreaterThanOrEqual(1);

    const rules = ctx.brain.store.listRules(ctx.brain.activeProjectId!);
    const autoRules = rules.filter(r => r.metadata?.autoDetected === true);
    expect(autoRules.length).toBeGreaterThanOrEqual(1);

    // At least one rule should reference kebab-case or -store
    const texts = autoRules.map(r => r.content.toLowerCase());
    const hasStyleRule = texts.some(t => t.includes('kebab') || t.includes('-store'));
    expect(hasStyleRule).toBe(true);
  });

  it('captures exports and language per file', async () => {
    await scanProject(ctx.brain, { projectPath: FIXTURE });
    const digest = ctx.brain.store.getFileDigestByPath(
      ctx.brain.activeProjectId!,
      'src/stores/user-store.ts',
    );
    expect(digest).toBeTruthy();
    expect(digest!.language).toBe('typescript');
    expect(digest!.exports).toContain('userStore');
  });

  it('respects include_glob filter', async () => {
    const result = await scanProject(ctx.brain, {
      projectPath: FIXTURE,
      includeGlob: ['md'],
    });
    const digests = ctx.brain.store.listFileDigests(ctx.brain.activeProjectId!);
    expect(digests.every(d => d.path.endsWith('.md'))).toBe(true);
    expect(result.files_scanned).toBeGreaterThanOrEqual(1);
  });

  it('throws when path does not exist', async () => {
    await expect(scanProject(ctx.brain, {
      projectPath: '/tmp/non-existent-devbrain-scan-target-xyz',
    })).rejects.toThrow();
  });
});
