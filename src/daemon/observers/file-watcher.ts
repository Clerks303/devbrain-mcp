import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'chokidar';
import type { DirectDbWriter } from '../db-writer.js';
import type { WriteQueue } from '../write-queue.js';
import type { EmbeddingQueue } from '../embedding-queue.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import type { DaemonConfig } from '../types.js';
import { analyzeFileContent } from '../digest-analyzer.js';
import { daemonMeta } from '../types.js';

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly projectId: string;
  private readonly projectPath: string;
  private readonly writer: DirectDbWriter;
  private readonly writeQueue: WriteQueue;
  private readonly embeddingQueue: EmbeddingQueue | null;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly config: DaemonConfig;

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
    this.config = opts.config;
  }

  async start(): Promise<void> {
    // Dynamic import — chokidar is optional dependency
    const { watch } = await import('chokidar');

    const ignoredPatterns = this.config.excludePatterns.map(p =>
      p.includes('*') ? new RegExp(p.replace(/\*/g, '.*')) : `**/${p}/**`
    );

    this.watcher = watch(this.projectPath, {
      ignored: [/(^|[/\\])\../, ...ignoredPatterns], // ignore dotfiles + config patterns
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.fileDebounceMs,
        pollInterval: 100,
      },
      usePolling: false,
      depth: 20,
    });

    const allowedExts = new Set(this.config.autoDigestExtensions);

    this.watcher
      .on('add', (filePath: string) => void this.handleFile(filePath, allowedExts))
      .on('change', (filePath: string) => void this.handleFile(filePath, allowedExts))
      .on('unlink', (filePath: string) => void this.handleDelete(filePath))
      .on('error', (err: unknown) => {
        console.error(`[file-watcher] Error watching ${this.projectPath}:`, err);
      });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async handleFile(filePath: string, allowedExts: Set<string>): Promise<void> {
    const ext = path.extname(filePath);
    if (!allowedExts.has(ext)) return;

    // Check file size
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > this.config.digestMaxFileSizeBytes) return;
    } catch {
      return; // File may have been deleted between event and processing
    }

    const relativePath = path.relative(this.projectPath, filePath);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const analysis = analyzeFileContent(content, ext);

      // Check if hash changed (skip if same)
      const existing = this.writer.store.getFileDigestByPath(this.projectId, relativePath);
      if (existing && existing.contentHash === analysis.contentHash) return;

      await this.writeQueue.enqueue(async () => {
        const digest = this.writer.store.upsertFileDigest({
          projectId: this.projectId,
          path: relativePath,
          contentHash: analysis.contentHash,
          summary: null,
          exports: analysis.exports,
          imports: analysis.imports,
          language: analysis.language,
          loc: analysis.loc,
          status: 'active',
          metadata: daemonMeta({ ext }),
        });

        // Embed file path + exports for searchability
        if (this.embeddingQueue && this.embeddingProvider) {
          const text = [relativePath, ...analysis.exports].join(' ');
          const id = digest.id;
          this.embeddingQueue.enqueue(async () => {
            const embedding = await this.embeddingProvider!.embed(text);
            this.writer.vectorStore.upsertFileDigestEmbedding(id, embedding);
          });
        }
      });
    } catch (err) {
      console.error(`[file-watcher] Failed to digest ${relativePath}:`, err);
    }
  }

  private async handleDelete(filePath: string): Promise<void> {
    const relativePath = path.relative(this.projectPath, filePath);

    await this.writeQueue.enqueue(async () => {
      try {
        const existing = this.writer.store.getFileDigestByPath(this.projectId, relativePath);
        if (existing) {
          this.writer.store.upsertFileDigest({
            projectId: this.projectId,
            path: relativePath,
            contentHash: existing.contentHash,
            summary: existing.summary,
            exports: existing.exports,
            imports: existing.imports,
            language: existing.language,
            loc: existing.loc,
            status: 'deleted',
            metadata: daemonMeta({ previousStatus: existing.status }),
          });
        }
      } catch (err) {
        console.error(`[file-watcher] Failed to mark deleted ${relativePath}:`, err);
      }
    });
  }
}
