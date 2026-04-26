import type { DirectDbWriter } from './db-writer.js';
import type { WriteQueue } from './write-queue.js';
import type { EmbeddingQueue } from './embedding-queue.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { DaemonConfig } from './types.js';
import { GitObserver } from './observers/git-observer.js';
import { FileWatcher } from './observers/file-watcher.js';
import { BuildObserver } from './observers/build-observer.js';
import { DependencyTracker } from './observers/dependency-tracker.js';

/**
 * Aggregates all observers for a single project.
 */
export class ProjectWatcher {
  private readonly gitObserver: GitObserver;
  private readonly fileWatcher: FileWatcher;
  private readonly buildObserver: BuildObserver;
  private readonly dependencyTracker: DependencyTracker;
  private running = false;

  readonly projectId: string;
  readonly projectPath: string;

  constructor(opts: {
    projectId: string;
    projectPath: string;
    writer: DirectDbWriter;
    writeQueue: WriteQueue;
    embeddingQueue: EmbeddingQueue | null;
    embeddingProvider: EmbeddingProvider | null;
    config: DaemonConfig;
  }) {
    this.projectId = opts.projectId;
    this.projectPath = opts.projectPath;

    this.gitObserver = new GitObserver(opts);
    this.fileWatcher = new FileWatcher(opts);
    this.buildObserver = new BuildObserver({
      projectId: opts.projectId,
      writer: opts.writer,
      writeQueue: opts.writeQueue,
    });
    this.dependencyTracker = new DependencyTracker(opts);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start all observers concurrently
    await Promise.all([
      this.gitObserver.start(),
      this.fileWatcher.start(),
      this.buildObserver.start(),
      this.dependencyTracker.start(),
    ]);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    await Promise.all([
      this.gitObserver.stop(),
      this.fileWatcher.stop(),
      this.buildObserver.stop(),
      this.dependencyTracker.stop(),
    ]);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
