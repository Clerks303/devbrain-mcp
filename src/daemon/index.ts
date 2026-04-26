import { loadDaemonConfig } from './config.js';
import { DirectDbWriter } from './db-writer.js';
import { ProjectManager } from './project-manager.js';
import { EmbeddingQueue } from './embedding-queue.js';
import { writePid, removePid, isDaemonRunning } from './pid-manager.js';
import { createEmbeddingProvider, type EmbeddingProvider } from '../embeddings/provider.js';

export async function startDaemon(): Promise<void> {
  // Check if another instance is already running
  if (isDaemonRunning()) {
    console.error('[devbrain-daemon] Another instance is already running. Use `devbrain daemon stop` first.');
    process.exit(1);
  }

  const config = loadDaemonConfig();
  writePid();

  const writer = new DirectDbWriter(config.dbPath);

  // Initialize embedding provider
  let embeddingProvider: EmbeddingProvider | null = null;
  let embeddingQueue: EmbeddingQueue | null = null;

  if (config.generateEmbeddings && config.embeddingProvider !== 'none') {
    try {
      embeddingProvider = await createEmbeddingProvider({
        embeddingProvider: config.embeddingProvider,
        embeddingDimension: config.embeddingDimension,
        openaiApiKey: config.openaiApiKey,
        openaiModel: config.openaiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        ollamaModel: config.ollamaModel,
        dbPath: config.dbPath,
        transport: 'stdio',
      });
      embeddingQueue = new EmbeddingQueue(100); // 10 embeddings/s
    } catch (err) {
      console.error('[devbrain-daemon] Failed to init embedding provider, running without embeddings:', err);
    }
  }

  const manager = new ProjectManager(writer, embeddingProvider, embeddingQueue, config);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[devbrain-daemon] ${signal} received, shutting down...`);
    await manager.stopAll();
    if (embeddingQueue) await embeddingQueue.flush();
    writer.close();
    removePid();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => void manager.reload());

  await manager.startAll();
  console.error(`[devbrain-daemon] Started (PID ${process.pid}), ${manager.projectCount} projects watched`);
}
