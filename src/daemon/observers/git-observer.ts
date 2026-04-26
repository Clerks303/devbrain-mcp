import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DirectDbWriter } from '../db-writer.js';
import type { EmbeddingQueue } from '../embedding-queue.js';
import type { WriteQueue } from '../write-queue.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import type { GitEvent, DaemonConfig } from '../types.js';
import { daemonMeta } from '../types.js';

const execFileAsync = promisify(execFile);

export class GitObserver {
  private lastKnownHash: string | null = null;
  private previousBranch: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly projectId: string;
  private readonly projectPath: string;
  private readonly writer: DirectDbWriter;
  private readonly writeQueue: WriteQueue;
  private readonly embeddingQueue: EmbeddingQueue | null;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly pollIntervalMs: number;

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
    this.writer = opts.writer;
    this.writeQueue = opts.writeQueue;
    this.embeddingQueue = opts.embeddingQueue;
    this.embeddingProvider = opts.embeddingProvider;
    this.pollIntervalMs = opts.config.gitPollIntervalMs;
  }

  async start(): Promise<void> {
    // Check if it's a git repo
    try {
      await this.git(['rev-parse', '--is-inside-work-tree']);
    } catch {
      console.error(`[git-observer] ${this.projectPath} is not a git repo, skipping`);
      return;
    }

    // Resume: find last known commit from DB
    this.lastKnownHash = this.findLastKnownCommit();

    // If no known commit, start from HEAD
    if (!this.lastKnownHash) {
      try {
        this.lastKnownHash = (await this.git(['rev-parse', 'HEAD'])).trim();
      } catch {
        // Empty repo, no commits yet
        this.lastKnownHash = null;
      }
    }

    this.previousBranch = await this.getCurrentBranch();

    // Start polling
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    // Run first poll immediately
    await this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const currentHash = (await this.git(['rev-parse', 'HEAD'])).trim();
      const currentBranch = await this.getCurrentBranch();

      // Branch switch detection
      if (currentBranch && this.previousBranch && currentBranch !== this.previousBranch) {
        await this.handleEvent({
          type: 'branch_switch',
          branch: currentBranch,
        });
        this.previousBranch = currentBranch;
      }

      // No new commits
      if (currentHash === this.lastKnownHash) return;

      // Get new commits (oldest first)
      const range = this.lastKnownHash ? `${this.lastKnownHash}..${currentHash}` : currentHash;
      const logArgs = ['log', '--format=%H|%an|%aI|%s', '--reverse'];
      if (this.lastKnownHash) {
        logArgs.push(range);
      } else {
        logArgs.push('-1', currentHash);
      }

      const logOutput = await this.git(logArgs);
      const commits = logOutput.trim().split('\n').filter(Boolean);

      for (const line of commits) {
        const [hash, author, date, ...messageParts] = line.split('|');
        if (!hash) continue;
        const message = messageParts.join('|'); // message may contain |

        // Get files changed in this commit
        const filesOutput = await this.git(['diff-tree', '--no-commit-id', '-r', '--name-status', hash]);
        const files = filesOutput.trim().split('\n').filter(Boolean).map(fileLine => {
          const [status, ...pathParts] = fileLine.split('\t');
          return {
            path: pathParts.join('\t'),
            status: (status?.charAt(0) ?? 'M') as 'A' | 'M' | 'D' | 'R',
          };
        });

        const isMerge = message.startsWith('Merge ');
        await this.handleEvent({
          type: isMerge ? 'merge' : 'commit',
          hash,
          message,
          author,
          files,
        });
      }

      this.lastKnownHash = currentHash;
      this.previousBranch = currentBranch;
    } catch (err) {
      console.error(`[git-observer] Poll error for ${this.projectPath}:`, err);
    }
  }

  private async handleEvent(event: GitEvent): Promise<void> {
    await this.writeQueue.enqueue(async () => {
      if (event.type === 'commit' || event.type === 'merge') {
        // Create commit entity
        const entity = this.writer.store.addEntity({
          name: `commit:${event.hash?.slice(0, 8)}`,
          type: 'commit',
          projectId: this.projectId,
          content: event.message ?? null,
          metadata: daemonMeta({
            hash: event.hash,
            author: event.author,
            fileCount: event.files?.length ?? 0,
          }),
        });

        // Embed commit message
        if (this.embeddingQueue && this.embeddingProvider && event.message) {
          const msg = event.message;
          const id = entity.id;
          this.embeddingQueue.enqueue(async () => {
            const embedding = await this.embeddingProvider!.embed(msg);
            this.writer.vectorStore.upsertEntityEmbedding(id, embedding);
          });
        }

        // Add observations for modified files
        if (event.files) {
          for (const file of event.files) {
            this.writer.store.addObservation({
              entityId: entity.id,
              content: `${file.status} ${file.path}`,
              source: 'git-observer',
              category: 'file_change',
            });
          }
        }
      } else if (event.type === 'branch_switch') {
        // Log as observation on the project
        const entities = this.writer.store.findEntitiesByName('project:', this.projectId);
        if (entities.length > 0) {
          this.writer.store.addObservation({
            entityId: entities[0].id,
            content: `Branch switched to ${event.branch}`,
            source: 'git-observer',
            category: 'branch_switch',
          });
        }
      }
    });
  }

  private findLastKnownCommit(): string | null {
    try {
      const entities = this.writer.store.findEntitiesByName('commit:', this.projectId);
      if (entities.length > 0) {
        const meta = entities[0].metadata as Record<string, unknown> | null;
        return typeof meta?.hash === 'string' ? meta.hash : null;
      }
    } catch { /* ignore */ }
    return null;
  }

  private async getCurrentBranch(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    } catch {
      return null;
    }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.projectPath,
      timeout: 10_000,
      maxBuffer: 1024 * 1024, // 1 MB
    });
    return stdout;
  }
}
