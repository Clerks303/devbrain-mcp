import fs from 'node:fs';
import path from 'node:path';
import type { DirectDbWriter } from '../db-writer.js';
import type { WriteQueue } from '../write-queue.js';
import type { BuildResult } from '../types.js';
import { daemonMeta } from '../types.js';

const SENTINEL_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  '.devbrain', 'projects',
);

export class BuildObserver {
  private watcher: import('chokidar').FSWatcher | null = null;
  private readonly projectId: string;
  private readonly writer: DirectDbWriter;
  private readonly writeQueue: WriteQueue;
  private readonly sentinelPath: string;

  constructor(opts: {
    projectId: string;
    writer: DirectDbWriter;
    writeQueue: WriteQueue;
  }) {
    this.projectId = opts.projectId;
    this.writer = opts.writer;
    this.writeQueue = opts.writeQueue;
    this.sentinelPath = path.join(SENTINEL_DIR, opts.projectId, 'build-result.json');
  }

  async start(): Promise<void> {
    // Ensure sentinel directory exists
    const dir = path.dirname(this.sentinelPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Watch sentinel file
    const { watch } = await import('chokidar');
    this.watcher = watch(this.sentinelPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher.on('change', () => void this.handleBuildResult());
    this.watcher.on('add', () => void this.handleBuildResult());
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Get the sentinel file path for writing from hooks/daemon */
  static getSentinelPath(projectId: string): string {
    return path.join(SENTINEL_DIR, projectId, 'build-result.json');
  }

  private async handleBuildResult(): Promise<void> {
    let result: BuildResult;
    try {
      const raw = fs.readFileSync(this.sentinelPath, 'utf-8');
      result = JSON.parse(raw) as BuildResult;
    } catch {
      return; // Invalid or partial file
    }

    await this.writeQueue.enqueue(async () => {
      if (result.exitCode !== 0) {
        // Build failed — create issue
        const existingIssues = this.writer.store.listIssues(this.projectId, { status: 'open' })
          .filter(i => i.type === 'build_failure');

        if (existingIssues.length === 0) {
          this.writer.store.addIssue({
            projectId: this.projectId,
            entityId: null,
            filePath: null,
            type: 'build_failure',
            title: `Build failed: ${result.command}`,
            description: result.outputTail,
            severity: 'high',
            metadata: daemonMeta({
              exitCode: result.exitCode,
              command: result.command,
              durationMs: result.durationMs,
            }),
          });
        }
      } else {
        // Build succeeded — resolve open build_failure issues
        const openIssues = this.writer.store.listIssues(this.projectId, { status: 'open' })
          .filter(i => i.type === 'build_failure');

        for (const issue of openIssues) {
          this.writer.store.updateIssue(issue.id, {
            status: 'resolved',
            resolution: `Build succeeded: ${result.command} (${result.durationMs}ms)`,
          });
        }
      }
    });
  }
}
