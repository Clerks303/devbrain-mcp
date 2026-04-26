import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DaemonConfig } from './types.js';

const DEVBRAIN_DIR = path.join(os.homedir(), '.devbrain');
const CONFIG_FILE_PATH = path.join(DEVBRAIN_DIR, 'config.json');

interface RawConfigFile {
  dbPath?: string;
  embeddingProvider?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  daemon?: Record<string, unknown>;
}

const DEFAULTS = {
  gitPollIntervalMs: 30_000,
  fileDebounceMs: 500,
  digestMaxFileSizeBytes: 524_288, // 512 KB
  maxFilesPerProject: 5_000,
  projectRefreshIntervalMs: 300_000, // 5 min
  generateEmbeddings: true,
  watchedProjectIds: null as string[] | null,
  excludePatterns: [
    'node_modules', '.git', 'dist', 'build',
    '.next', '__pycache__', '*.min.js', 'coverage',
    '.turbo', '.cache', '.parcel-cache',
  ],
  autoDigestExtensions: [
    '.ts', '.tsx', '.js', '.jsx', '.mjs',
    '.py', '.rs', '.go', '.java', '.kt',
    '.sql', '.json', '.yaml', '.yml',
    '.css', '.scss', '.html', '.svelte', '.vue',
  ],
  buildOutputDirs: ['dist', 'build', '.next', 'out'],
  packageFiles: ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'],
} as const;

const DIMENSION_BY_PROVIDER: Record<string, number> = {
  openai: 1536,
  ollama: 768,
  none: 1536,
};

function readConfigFile(): RawConfigFile {
  try {
    if (!fs.existsSync(CONFIG_FILE_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as RawConfigFile;
  } catch {
    return {};
  }
}

function asStringArray(val: unknown): string[] | null {
  if (!Array.isArray(val)) return null;
  return val.filter((v): v is string => typeof v === 'string');
}

export function loadDaemonConfig(): DaemonConfig {
  const file = readConfigFile();
  const daemon = (file.daemon ?? {}) as Record<string, unknown>;

  const openaiApiKey = process.env.OPENAI_API_KEY ?? process.env.DEVBRAIN_OPENAI_API_KEY ?? file.openaiApiKey;
  const rawProvider = process.env.DEVBRAIN_EMBEDDING_PROVIDER ?? file.embeddingProvider;
  const embeddingProvider: DaemonConfig['embeddingProvider'] =
    rawProvider === 'openai' || rawProvider === 'ollama' || rawProvider === 'none'
      ? rawProvider
      : openaiApiKey ? 'openai' : 'ollama';

  return {
    dbPath:
      process.env.DEVBRAIN_DB_PATH ??
      file.dbPath ??
      path.join(DEVBRAIN_DIR, 'devbrain.db'),
    embeddingProvider,
    embeddingDimension: DIMENSION_BY_PROVIDER[embeddingProvider] ?? 1536,
    openaiApiKey,
    openaiModel: process.env.DEVBRAIN_OPENAI_MODEL ?? file.openaiModel ?? 'text-embedding-3-small',
    ollamaBaseUrl: process.env.DEVBRAIN_OLLAMA_BASE_URL ?? file.ollamaBaseUrl ?? 'http://localhost:11434',
    ollamaModel: process.env.DEVBRAIN_OLLAMA_MODEL ?? file.ollamaModel ?? 'nomic-embed-text',
    gitPollIntervalMs: typeof daemon.gitPollIntervalMs === 'number' ? daemon.gitPollIntervalMs : DEFAULTS.gitPollIntervalMs,
    fileDebounceMs: typeof daemon.fileDebounceMs === 'number' ? daemon.fileDebounceMs : DEFAULTS.fileDebounceMs,
    digestMaxFileSizeBytes: typeof daemon.digestMaxFileSizeBytes === 'number' ? daemon.digestMaxFileSizeBytes : DEFAULTS.digestMaxFileSizeBytes,
    maxFilesPerProject: typeof daemon.maxFilesPerProject === 'number' ? daemon.maxFilesPerProject : DEFAULTS.maxFilesPerProject,
    projectRefreshIntervalMs: typeof daemon.projectRefreshIntervalMs === 'number' ? daemon.projectRefreshIntervalMs : DEFAULTS.projectRefreshIntervalMs,
    generateEmbeddings: typeof daemon.generateEmbeddings === 'boolean' ? daemon.generateEmbeddings : DEFAULTS.generateEmbeddings,
    watchedProjectIds: asStringArray(daemon.watchedProjectIds),
    excludePatterns: asStringArray(daemon.excludePatterns) ?? [...DEFAULTS.excludePatterns],
    autoDigestExtensions: asStringArray(daemon.autoDigestExtensions) ?? [...DEFAULTS.autoDigestExtensions],
    buildOutputDirs: asStringArray(daemon.buildOutputDirs) ?? [...DEFAULTS.buildOutputDirs],
    packageFiles: asStringArray(daemon.packageFiles) ?? [...DEFAULTS.packageFiles],
  };
}
