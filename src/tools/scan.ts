import { z } from 'zod';
import fs from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { analyzeFileContent, detectLanguage } from '../daemon/digest-analyzer.js';
import type { FileDigest } from '../types.js';

const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  '.cache',
  'coverage',
  '.DS_Store',
];

const INCLUDED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.swift',
  '.rb', '.php', '.cs', '.md', '.sql',
  '.yaml', '.yml', '.toml',
]);

const MAX_FILE_BYTES = 512 * 1024;

export interface ScanResult {
  project_id: string;
  files_scanned: number;
  files_skipped: number;
  entities_created: number;
  entities_updated: number;
  digests_created: number;
  digests_updated: number;
  conventions_detected: number;
  duration_ms: number;
}

function matchesAnyPattern(pathSegments: string[], patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    // Treat each pattern as a simple segment or glob-ish substring match
    const normalized = pattern.replace(/\*\*\/?|\/\*\*/g, '').replace(/\*/g, '');
    if (!normalized) continue;
    if (pathSegments.some(seg => seg === normalized || seg.includes(normalized))) {
      return true;
    }
  }
  return false;
}

async function walkDirectory(
  root: string,
  excludeSegments: readonly string[],
): Promise<string[]> {
  const results: string[] = [];

  async function recurse(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDir: boolean; isFile: boolean }> = [];
    try {
      const raw = await fs.readdir(dir, { withFileTypes: true });
      entries = raw.map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (excludeSegments.includes(entry.name)) continue;
      if (entry.name.startsWith('.') && !['.env.example', '.github'].includes(entry.name)) {
        // Skip hidden files/dirs except a few useful ones
        if (entry.name !== '.github') continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDir) {
        await recurse(fullPath);
      } else if (entry.isFile) {
        results.push(fullPath);
      }
    }
  }

  await recurse(root);
  return results;
}

interface ConventionDetection {
  pattern: string;
  content: string;
  sample_size: number;
}

function detectConventions(
  digests: Array<{ path: string; language: string | null }>,
): ConventionDetection[] {
  const conventions: ConventionDetection[] = [];

  // 1. Kebab-case filenames for TSX components
  const tsxFiles = digests.filter(d => d.path.endsWith('.tsx'));
  if (tsxFiles.length >= 5) {
    const kebabCount = tsxFiles.filter(f => {
      const base = path.basename(f.path, '.tsx');
      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(base);
    }).length;
    if (kebabCount / tsxFiles.length >= 0.8) {
      conventions.push({
        pattern: '**/*.tsx',
        content: 'TSX component filenames use kebab-case (e.g. user-profile.tsx).',
        sample_size: tsxFiles.length,
      });
    }
  }

  // 2. Store naming convention
  const storeFiles = digests.filter(d => d.path.includes('/stores/') || d.path.includes('/store/'));
  if (storeFiles.length >= 3) {
    const withSuffix = storeFiles.filter(f => /-store\.(ts|js)$/.test(f.path)).length;
    if (withSuffix / storeFiles.length >= 0.8) {
      conventions.push({
        pattern: '**/stores/*.ts',
        content: 'Files under stores/ end with -store.ts suffix.',
        sample_size: storeFiles.length,
      });
    }
  }

  // 3. Test file colocation vs __tests__
  const testFiles = digests.filter(d => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(d.path));
  if (testFiles.length >= 5) {
    const colocated = testFiles.filter(f => !f.path.includes('__tests__') && !f.path.includes('/tests/')).length;
    const ratio = colocated / testFiles.length;
    if (ratio >= 0.8) {
      conventions.push({
        pattern: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        content: 'Tests are colocated next to source files (not in __tests__/ or tests/).',
        sample_size: testFiles.length,
      });
    } else if (ratio <= 0.2) {
      conventions.push({
        pattern: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        content: 'Tests live in dedicated directories (tests/, __tests__/), not colocated.',
        sample_size: testFiles.length,
      });
    }
  }

  return conventions;
}

export interface ScanOptions {
  readonly projectPath: string;
  readonly includeGlob?: readonly string[];
  readonly excludeGlob?: readonly string[];
}

/**
 * Core scan implementation — testable without MCP server.
 * Resolves or creates the project, walks source files, upserts digests,
 * detects simple conventions.
 */
export async function scanProject(
  brain: DevBrain,
  options: ScanOptions,
): Promise<ScanResult> {
  const started = Date.now();

  // Validate path
  const stat = await fs.stat(options.projectPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${options.projectPath}`);
  }

  // Resolve or create project
  let project = brain.store.getProjectByPath(options.projectPath);
  if (!project) {
    const name = options.projectPath.split(path.sep).filter(Boolean).pop() ?? 'unknown';
    project = brain.store.addProject({ name, path: options.projectPath });
  }
  brain.activeProjectId = project.id;

  const excludeSegments = [
    ...DEFAULT_EXCLUDES,
    ...(options.excludeGlob ?? []),
  ];

  const includeExts = options.includeGlob
    ? new Set(options.includeGlob.map(e => e.startsWith('.') ? e : `.${e}`))
    : INCLUDED_EXTENSIONS;

  const allFiles = await walkDirectory(options.projectPath, excludeSegments);

  let filesScanned = 0;
  let filesSkipped = 0;
  let digestsCreated = 0;
  let digestsUpdated = 0;

  const digestSummaries: Array<{ path: string; language: string | null }> = [];

  const db = brain.store.getDb();
  const runScan = db.transaction((): void => {
    for (const absPath of allFiles) {
      const ext = path.extname(absPath).toLowerCase();
      if (!includeExts.has(ext)) {
        filesSkipped++;
        continue;
      }

      const relPath = path.relative(options.projectPath, absPath);
      if (matchesAnyPattern(relPath.split(path.sep), excludeSegments)) {
        filesSkipped++;
        continue;
      }

      let fileStat;
      try {
        fileStat = statSync(absPath);
      } catch {
        filesSkipped++;
        continue;
      }

      if (fileStat.size > MAX_FILE_BYTES) {
        filesSkipped++;
        continue;
      }

      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        filesSkipped++;
        continue;
      }

      const analysis = analyzeFileContent(content, ext);
      const existing = brain.store.getFileDigestByPath(project!.id, relPath);

      if (existing && existing.contentHash === analysis.contentHash) {
        filesScanned++;
        digestSummaries.push({ path: relPath, language: analysis.language });
        continue;
      }

      let digest: FileDigest;
      try {
        digest = brain.store.upsertFileDigest({
          projectId: project!.id,
          path: relPath,
          contentHash: analysis.contentHash,
          summary: existing?.summary ?? null,
          exports: analysis.exports,
          imports: analysis.imports,
          language: analysis.language ?? detectLanguage(ext),
          loc: analysis.loc,
          status: 'active',
          metadata: { ext, scannedAt: new Date().toISOString() },
        });
      } catch {
        filesSkipped++;
        continue;
      }

      filesScanned++;
      digestSummaries.push({ path: relPath, language: digest.language });

      if (existing) {
        digestsUpdated++;
      } else {
        digestsCreated++;
      }

      if (filesScanned % 250 === 0) {
        console.error(`[devbrain-scan] ${filesScanned}/${allFiles.length} files processed...`);
      }
    }
  });

  runScan();

  const detections = detectConventions(digestSummaries);
  let conventionsAdded = 0;
  for (const detection of detections) {
    try {
      brain.store.addRule({
        projectId: project.id,
        scope: 'file_pattern',
        pattern: detection.pattern,
        content: detection.content,
        severity: 'should',
        metadata: {
          autoDetected: true,
          sampleSize: detection.sample_size,
          detectedAt: new Date().toISOString(),
        },
      });
      conventionsAdded++;
    } catch (e) {
      console.error('[devbrain-scan] Failed to add rule:', e);
    }
  }

  const duration = Date.now() - started;

  return {
    project_id: project.id,
    files_scanned: filesScanned,
    files_skipped: filesSkipped,
    entities_created: 0,
    entities_updated: 0,
    digests_created: digestsCreated,
    digests_updated: digestsUpdated,
    conventions_detected: conventionsAdded,
    duration_ms: duration,
  };
}

export function registerScanTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_scan_project',
    'Scan a project directory once: walk all source files, upsert file digests, detect simple conventions. Idempotent — existing digests are only updated if content hash changed.',
    {
      path: z.string().describe('Absolute path to the project root'),
      include_glob: z.array(z.string()).optional().describe('Extensions to include (e.g. ["ts","py"]) — overrides defaults'),
      exclude_glob: z.array(z.string()).optional().describe('Directory or file names to exclude'),
    },
    async ({ path: projectPath, include_glob, exclude_glob }) => {
      try {
        const result = await scanProject(brain, {
          projectPath,
          includeGlob: include_glob,
          excludeGlob: exclude_glob,
        });

        console.error(`[devbrain-scan] Done: ${result.files_scanned} scanned, ${result.conventions_detected} conventions, ${result.duration_ms}ms`);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Scan failed: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
