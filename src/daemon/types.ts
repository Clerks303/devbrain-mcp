/** Shared types for the DevBrain daemon */

export interface DaemonConfig {
  readonly dbPath: string;
  readonly embeddingProvider: 'openai' | 'ollama' | 'none';
  readonly embeddingDimension: number;
  readonly openaiApiKey?: string;
  readonly openaiModel?: string;
  readonly ollamaBaseUrl?: string;
  readonly ollamaModel?: string;
  readonly gitPollIntervalMs: number;
  readonly fileDebounceMs: number;
  readonly digestMaxFileSizeBytes: number;
  readonly maxFilesPerProject: number;
  readonly projectRefreshIntervalMs: number;
  readonly generateEmbeddings: boolean;
  readonly watchedProjectIds: string[] | null;
  readonly excludePatterns: string[];
  readonly autoDigestExtensions: string[];
  readonly buildOutputDirs: string[];
  readonly packageFiles: string[];
}

export interface GitEvent {
  readonly type: 'commit' | 'branch_switch' | 'merge';
  readonly hash?: string;
  readonly message?: string;
  readonly author?: string;
  readonly files?: ReadonlyArray<{ path: string; status: 'A' | 'M' | 'D' | 'R' }>;
  readonly branch?: string;
}

export interface DependencyChange {
  readonly name: string;
  readonly type: 'added' | 'removed' | 'updated';
  readonly section: 'dependencies' | 'devDependencies' | 'peerDependencies';
  readonly previousVersion: string | null;
  readonly newVersion: string | null;
}

export interface BuildResult {
  readonly exitCode: number;
  readonly command: string;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly outputTail: string;
}

export interface DigestAnalysis {
  readonly contentHash: string;
  readonly loc: number;
  readonly imports: string[];
  readonly exports: string[];
  readonly language: string | null;
}

/** Source tagging metadata added by the daemon */
export interface DaemonMetadata {
  readonly source: 'daemon';
  readonly observedAt: string;
  readonly [key: string]: unknown;
}

export function daemonMeta(extra?: Record<string, unknown>): DaemonMetadata {
  return {
    source: 'daemon',
    observedAt: new Date().toISOString(),
    ...extra,
  };
}
