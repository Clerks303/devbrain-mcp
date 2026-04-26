import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DirectDbWriter } from './db-writer.js';
import type { EmbeddingQueue } from './embedding-queue.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { DaemonConfig } from './types.js';
import { WriteQueue } from './write-queue.js';
import { ProjectWatcher } from './project-watcher.js';

const execFileAsync = promisify(execFile);

/**
 * Manages N ProjectWatcher instances.
 * Loads projects from DB, validates them, and starts/stops watchers.
 */
export class ProjectManager {
  private readonly watchers = new Map<string, ProjectWatcher>();
  private readonly writeQueue: WriteQueue;
  private readonly writer: DirectDbWriter;
  private readonly embeddingQueue: EmbeddingQueue | null;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly config: DaemonConfig;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    writer: DirectDbWriter,
    embeddingProvider: EmbeddingProvider | null,
    embeddingQueue: EmbeddingQueue | null,
    config: DaemonConfig,
  ) {
    this.writer = writer;
    this.embeddingProvider = embeddingProvider;
    this.embeddingQueue = embeddingQueue;
    this.config = config;
    this.writeQueue = new WriteQueue();
  }

  get projectCount(): number {
    return this.watchers.size;
  }

  async startAll(): Promise<void> {
    await this.loadAndStartProjects();

    // Periodic refresh to detect new projects
    this.refreshTimer = setInterval(
      () => void this.reload(),
      this.config.projectRefreshIntervalMs,
    );
  }

  async stopAll(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    const stopPromises = [...this.watchers.values()].map(w => w.stop());
    await Promise.all(stopPromises);
    this.watchers.clear();
    await this.writeQueue.flush();
  }

  /** SIGHUP handler: reload project list without restarting */
  async reload(): Promise<void> {
    console.error('[devbrain-daemon] Reloading project list...');
    await this.loadAndStartProjects();
    console.error(`[devbrain-daemon] Active projects: ${this.watchers.size}`);
  }

  private async loadAndStartProjects(): Promise<void> {
    const projects = this.writer.store.listProjects();

    const eligible = projects.filter(p => {
      if (!p.path) return false;
      // Filter by watchedProjectIds if specified
      if (this.config.watchedProjectIds !== null) {
        return this.config.watchedProjectIds.includes(p.id);
      }
      return true;
    });

    for (const project of eligible) {
      // Skip already-watched projects
      if (this.watchers.has(project.id)) continue;

      const projectPath = project.path!;

      // Validate directory exists
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        console.error(`[devbrain-daemon] Skipping ${project.name}: directory not found at ${projectPath}`);
        continue;
      }

      // Check if it's a git repo (optional — still watch for files even if not git)
      const isGitRepo = await this.isGitRepo(projectPath);
      if (!isGitRepo) {
        console.error(`[devbrain-daemon] ${project.name}: not a git repo, git observer disabled`);
      }

      try {
        const watcher = new ProjectWatcher({
          projectId: project.id,
          projectPath,
          writer: this.writer,
          writeQueue: this.writeQueue,
          embeddingQueue: this.embeddingQueue,
          embeddingProvider: this.embeddingProvider,
          config: this.config,
        });

        await watcher.start();
        this.watchers.set(project.id, watcher);
        console.error(`[devbrain-daemon] Watching: ${project.name} (${projectPath})`);
      } catch (err) {
        console.error(`[devbrain-daemon] Failed to start watcher for ${project.name}:`, err);
      }
    }

    // Stop watchers for removed projects
    for (const [id, watcher] of this.watchers) {
      if (!eligible.some(p => p.id === id)) {
        await watcher.stop();
        this.watchers.delete(id);
      }
    }
  }

  private async isGitRepo(dir: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
