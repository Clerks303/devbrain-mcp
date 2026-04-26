import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initDatabase } from './db/schema.js';
import { KnowledgeStore } from './db/store.js';
import { VectorStore } from './db/vector.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embeddings/provider.js';
import { loadConfig, type DevBrainConfig } from './config.js';
import { registerEntityTools } from './tools/entities.js';
import { registerRelationTools } from './tools/relations.js';
import { registerObservationTools } from './tools/observations.js';
import { registerSearchTools } from './tools/search.js';
import { registerProjectTools } from './tools/projects.js';
import { registerFileTools } from './tools/files.js';
import { registerIssueTools } from './tools/issues.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerRuleTools } from './tools/rules.js';
import { registerLessonTools } from './tools/lessons.js';
import { registerContextTools } from './tools/context.js';
import { registerHealthTools } from './tools/health.js';
import { registerSnapshotTools } from './tools/snapshots.js';
import { registerLinkingTools } from './tools/linking.js';
import { registerMetricsTools } from './tools/metrics.js';
import { registerLearningTools } from './tools/learning.js';
import { registerGoalTools } from './tools/goals.js';
import { registerScanTools } from './tools/scan.js';
import { registerResources } from './resources/graph.js';
import { registerPrompts } from './prompts/templates.js';
import { LearningOrchestrator } from './learning/index.js';
import type { LearningReport } from './learning/types.js';

export class DevBrain {
  readonly store: KnowledgeStore;
  readonly vectorStore: VectorStore;
  readonly embeddingProvider: EmbeddingProvider;
  readonly startedAt: Date;
  readonly dbPath: string;
  readonly config: DevBrainConfig;
  activeProjectId: string | null = null;
  activeSessionId: string | null = null;
  learningOrchestrator: LearningOrchestrator | null = null;
  lastLearningReport: LearningReport | null = null;

  constructor(
    store: KnowledgeStore,
    vectorStore: VectorStore,
    embeddingProvider: EmbeddingProvider,
    config: DevBrainConfig,
  ) {
    this.store = store;
    this.vectorStore = vectorStore;
    this.embeddingProvider = embeddingProvider;
    this.config = config;
    this.dbPath = config.dbPath;
    this.startedAt = new Date();
  }
}

export async function createServer(configOverride?: DevBrainConfig): Promise<{ server: McpServer; brain: DevBrain; config: DevBrainConfig }> {
  const config = configOverride ?? loadConfig();

  // Initialize embedding provider
  const embeddingProvider = await createEmbeddingProvider(config);

  // Initialize database
  const db = initDatabase(config.dbPath, embeddingProvider.dimension);

  // Create stores
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);

  // Create DevBrain instance
  const brain = new DevBrain(store, vectorStore, embeddingProvider, config);

  // Initialize Learning Engine
  brain.learningOrchestrator = new LearningOrchestrator(store, vectorStore, embeddingProvider);

  // Create MCP server
  const server = new McpServer({
    name: 'devbrain',
    version: '0.1.0',
  });

  // Register all tools
  registerEntityTools(server, brain);
  registerRelationTools(server, brain);
  registerObservationTools(server, brain);
  registerSearchTools(server, brain);
  registerProjectTools(server, brain);
  registerFileTools(server, brain);
  registerIssueTools(server, brain);
  registerSessionTools(server, brain);
  registerRuleTools(server, brain);
  registerLessonTools(server, brain);
  registerContextTools(server, brain);
  registerHealthTools(server, brain);
  registerSnapshotTools(server, brain);
  registerLinkingTools(server, brain);
  registerMetricsTools(server, brain);
  registerLearningTools(server, brain);
  registerGoalTools(server, brain);
  registerScanTools(server, brain);

  // Register resources
  registerResources(server, brain);

  // Register prompts
  registerPrompts(server);

  return { server, brain, config };
}
