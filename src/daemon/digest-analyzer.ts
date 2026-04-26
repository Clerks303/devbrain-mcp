/**
 * Pure module — no side effects, no dependencies on DB or filesystem.
 * Analyzes file content to extract metadata for DevBrain digests.
 */
import { createHash } from 'node:crypto';
import type { DigestAnalysis } from './types.js';

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.rb': 'ruby', '.php': 'php', '.cs': 'csharp',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.sql': 'sql', '.sh': 'shell', '.bash': 'shell',
  '.svelte': 'svelte', '.vue': 'vue',
};

const IMPORT_PATTERNS: readonly RegExp[] = [
  /^import\s+.+\s+from\s+['"]([^'"]+)['"]/gm,   // ES: import x from 'y'
  /^import\s+['"]([^'"]+)['"]/gm,                  // ES: import 'y'
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,        // CJS: require('y')
  /^from\s+(\S+)\s+import/gm,                      // Python: from x import y
];

const EXPORT_PATTERNS: readonly RegExp[] = [
  /^export\s+(?:default\s+)?(?:const|function|class|type|interface|enum|async\s+function)\s+(\w+)/gm,
  /^export\s+\{([^}]+)\}/gm,
  /^module\.exports\s*=/gm,
];

function extractMatches(content: string, patterns: readonly RegExp[]): string[] {
  const results = new Set<string>();
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const captured = match[1] ?? match[0];
      if (captured.includes(',')) {
        for (const name of captured.split(',')) {
          const trimmed = name.trim().split(/\s+as\s+/).pop()?.trim();
          if (trimmed) results.add(trimmed);
        }
      } else {
        results.add(captured.trim());
      }
    }
  }
  return [...results];
}

export function detectLanguage(ext: string): string | null {
  return LANGUAGE_BY_EXT[ext.toLowerCase()] ?? null;
}

export function analyzeFileContent(content: string, fileExtension: string): DigestAnalysis {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const loc = content.split('\n').length;
  const language = detectLanguage(fileExtension);
  const imports = extractMatches(content, IMPORT_PATTERNS);
  const exports = extractMatches(content, EXPORT_PATTERNS);
  return { contentHash, loc, imports, exports, language };
}

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
