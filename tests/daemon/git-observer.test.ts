import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../../src/db/schema.js';
import { DirectDbWriter } from '../../src/daemon/db-writer.js';
import { WriteQueue } from '../../src/daemon/write-queue.js';
import { GitObserver } from '../../src/daemon/observers/git-observer.js';
import type { DaemonConfig } from '../../src/daemon/types.js';

/**
 * End-to-end coverage for the git observer — the daemon's most critical
 * "production" path (observer -> WriteQueue -> store). Drives a real temp git
 * repository so the pipeline is exercised for real, but stays deterministic by
 * disabling the poll timer (huge interval) and triggering polls explicitly.
 */

const DIM = 8;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commit(dir: string, file: string, body: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message, '--no-gpg-sign']);
}

// GitObserver only reads `config.gitPollIntervalMs`; the rest is irrelevant here.
const config = { gitPollIntervalMs: 1_000_000 } as unknown as DaemonConfig;

interface Ctx {
  tmp: string;
  repo: string;
  dbPath: string;
  writer: DirectDbWriter;
  writeQueue: WriteQueue;
  observer: GitObserver;
  projectId: string;
}

describe('GitObserver — end-to-end commit ingestion', () => {
  let ctx: Ctx | null = null;

  afterEach(() => {
    if (ctx) {
      ctx.observer.stop();
      ctx.writer.close();
      fs.rmSync(ctx.tmp, { recursive: true, force: true });
      ctx = null;
    }
  });

  function bootstrap(initialMessage = 'chore: initial'): Ctx {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-git-test-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    commit(repo, 'index.ts', 'export const x = 1;\n', initialMessage);

    const dbPath = path.join(tmp, 'devbrain.db');
    initDatabase(dbPath, DIM).close(); // create schema, then hand the file to the daemon writer

    const writer = new DirectDbWriter(dbPath);
    const writeQueue = new WriteQueue();
    const project = writer.store.addProject({ name: 'gitproj', path: repo });
    const observer = new GitObserver({
      projectId: project.id,
      projectPath: repo,
      writer,
      writeQueue,
      embeddingQueue: null,
      embeddingProvider: null,
      config,
    });

    return { tmp, repo, dbPath, writer, writeQueue, observer, projectId: project.id };
  }

  it('records a new commit as an entity with per-file observations', async () => {
    ctx = bootstrap();

    // start() resumes from HEAD (commit #1), so it must NOT replay history.
    await ctx.observer.start();
    expect(ctx.writer.store.findEntitiesByName('commit:', ctx.projectId)).toHaveLength(0);

    // A brand-new commit appears while the observer is running.
    commit(ctx.repo, 'feature.ts', 'export const feature = true;\n', 'feat: add feature');
    await (ctx.observer as unknown as { poll(): Promise<void> }).poll();
    await ctx.writeQueue.flush();

    const commits = ctx.writer.store.findEntitiesByName('commit:', ctx.projectId);
    expect(commits).toHaveLength(1);
    expect(commits[0].type).toBe('commit');
    expect(commits[0].content).toContain('feat: add feature');

    const observations = ctx.writer.store.getObservations(commits[0].id);
    expect(observations.some(o => o.content.includes('feature.ts'))).toBe(true);
    expect(observations.every(o => o.source === 'git-observer')).toBe(true);

    // The queue actually processed work, with no swallowed errors.
    expect(ctx.writeQueue.errorCount).toBe(0);
    expect(ctx.writeQueue.processedCount).toBeGreaterThan(0);
  });

  it('skips gracefully when the directory is not a git repository', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-nogit-test-'));
    const notARepo = path.join(tmp, 'plain');
    fs.mkdirSync(notARepo);

    const dbPath = path.join(tmp, 'devbrain.db');
    initDatabase(dbPath, DIM).close();
    const writer = new DirectDbWriter(dbPath);
    const writeQueue = new WriteQueue();
    const project = writer.store.addProject({ name: 'plain', path: notARepo });
    const observer = new GitObserver({
      projectId: project.id,
      projectPath: notARepo,
      writer,
      writeQueue,
      embeddingQueue: null,
      embeddingProvider: null,
      config,
    });

    // Must not throw, and must not write anything.
    await expect(observer.start()).resolves.toBeUndefined();
    expect(writer.store.findEntitiesByName('commit:', project.id)).toHaveLength(0);

    observer.stop();
    writer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
