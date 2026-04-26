import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DevBrainConfig {
  readonly dbPath: string;
  readonly embeddingProvider: 'openai' | 'ollama' | 'none';
  readonly embeddingDimension: number;
  readonly openaiApiKey?: string;
  readonly openaiModel?: string;
  readonly ollamaBaseUrl?: string;
  readonly ollamaModel?: string;
  readonly transport: 'stdio' | 'sse';
  readonly port?: number;
  readonly hookPort?: number;
}

interface RawConfigFile {
  dbPath?: string;
  embeddingProvider?: string;
  embeddingDimension?: number;
  openaiApiKey?: string;
  openaiModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  transport?: string;
  port?: number;
  hookPort?: number;
}

const DEVBRAIN_DIR = path.join(os.homedir(), '.devbrain');
const CONFIG_FILE_PATH = path.join(DEVBRAIN_DIR, 'config.json');

const DIMENSION_BY_PROVIDER: Record<string, number> = {
  openai: 1536,
  ollama: 768,
  none: 1536,
};

const VALID_PROVIDERS = ['openai', 'ollama', 'none'] as const;
const VALID_TRANSPORTS = ['stdio', 'sse'] as const;

function isValidProvider(value: string): value is DevBrainConfig['embeddingProvider'] {
  return (VALID_PROVIDERS as readonly string[]).includes(value);
}

function isValidTransport(value: string): value is DevBrainConfig['transport'] {
  return (VALID_TRANSPORTS as readonly string[]).includes(value);
}

function readConfigFile(): RawConfigFile {
  try {
    if (!fs.existsSync(CONFIG_FILE_PATH)) {
      return {};
    }
    const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error('Warning: ~/.devbrain/config.json is not a valid object, ignoring.');
      return {};
    }
    return parsed as RawConfigFile;
  } catch (error) {
    console.error(`Warning: Failed to read config file at ${CONFIG_FILE_PATH}:`, error);
    return {};
  }
}

function inferProvider(openaiApiKey?: string): DevBrainConfig['embeddingProvider'] {
  if (openaiApiKey) return 'openai';
  return 'ollama';
}

export function loadConfig(): DevBrainConfig {
  const fileConfig = readConfigFile();

  // Env vars take precedence over file config
  const dbPath =
    process.env.DEVBRAIN_DB_PATH ??
    fileConfig.dbPath ??
    path.join(DEVBRAIN_DIR, 'devbrain.db');

  const openaiApiKey =
    process.env.OPENAI_API_KEY ??
    process.env.DEVBRAIN_OPENAI_API_KEY ??
    fileConfig.openaiApiKey;

  const openaiModel =
    process.env.DEVBRAIN_OPENAI_MODEL ??
    fileConfig.openaiModel ??
    'text-embedding-3-small';

  const ollamaBaseUrl =
    process.env.DEVBRAIN_OLLAMA_BASE_URL ??
    fileConfig.ollamaBaseUrl ??
    'http://localhost:11434';

  const ollamaModel =
    process.env.DEVBRAIN_OLLAMA_MODEL ??
    fileConfig.ollamaModel ??
    'nomic-embed-text';

  const rawProvider =
    process.env.DEVBRAIN_EMBEDDING_PROVIDER ??
    fileConfig.embeddingProvider;

  const embeddingProvider: DevBrainConfig['embeddingProvider'] =
    rawProvider && isValidProvider(rawProvider)
      ? rawProvider
      : inferProvider(openaiApiKey);

  const embeddingDimension =
    (process.env.DEVBRAIN_EMBEDDING_DIMENSION
      ? parseInt(process.env.DEVBRAIN_EMBEDDING_DIMENSION, 10)
      : undefined) ??
    fileConfig.embeddingDimension ??
    DIMENSION_BY_PROVIDER[embeddingProvider] ??
    1536;

  const rawTransport =
    process.env.DEVBRAIN_TRANSPORT ??
    fileConfig.transport;

  const transport: DevBrainConfig['transport'] =
    rawTransport && isValidTransport(rawTransport) ? rawTransport : 'stdio';

  const port =
    (process.env.DEVBRAIN_PORT
      ? parseInt(process.env.DEVBRAIN_PORT, 10)
      : undefined) ??
    fileConfig.port;

  const hookPort =
    (process.env.DEVBRAIN_HOOK_PORT
      ? parseInt(process.env.DEVBRAIN_HOOK_PORT, 10)
      : undefined) ??
    fileConfig.hookPort ??
    7384;

  return {
    dbPath,
    embeddingProvider,
    embeddingDimension,
    openaiApiKey,
    openaiModel,
    ollamaBaseUrl,
    ollamaModel,
    transport,
    port,
    hookPort,
  };
}
