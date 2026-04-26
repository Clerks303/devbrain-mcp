import { analyzePrompt } from './prompt-analyzer.js';
import { openReadonlyDb, resolveProjectId, fetchContext } from './context-fetcher.js';
import { scoreContext } from './relevance-scorer.js';
import { allocateBudget } from './token-budget.js';
import { formatContext, formatRulesFile } from './context-formatter.js';
import type { PromptAnalysis, TokenBudgetAllocation } from './types.js';

/** Minimum confidence to proceed with injection */
const MIN_CONFIDENCE = 0.3;

/** Pipeline timeout in milliseconds */
const PIPELINE_TIMEOUT_MS = 400;

export interface InjectionResult {
  readonly context: string;
  readonly analysis: PromptAnalysis;
  readonly allocation: TokenBudgetAllocation | null;
  readonly durationMs: number;
  readonly skipped: boolean;
  readonly skipReason?: string;
}

/**
 * Run the full context injection pipeline:
 * analyzePrompt → fetchContext → scoreContext → allocateBudget → formatContext
 *
 * Returns empty context string if:
 * - Prompt is trivial (confidence < 0.3)
 * - No database found
 * - No active project
 * - Pipeline exceeds timeout
 */
export async function injectContext(
  rawPrompt: string,
  sessionTurns?: number,
  dbPath?: string,
): Promise<InjectionResult> {
  const start = Date.now();

  // 1. Analyze prompt
  const analysis = analyzePrompt(rawPrompt);

  if (analysis.confidence < MIN_CONFIDENCE) {
    return {
      context: '',
      analysis,
      allocation: null,
      durationMs: Date.now() - start,
      skipped: true,
      skipReason: 'trivial_prompt',
    };
  }

  // 2. Open DB (read-only)
  const db = openReadonlyDb(dbPath);
  if (!db) {
    return {
      context: '',
      analysis,
      allocation: null,
      durationMs: Date.now() - start,
      skipped: true,
      skipReason: 'no_database',
    };
  }

  try {
    // 3. Resolve project
    const projectId = resolveProjectId(db);
    if (!projectId) {
      return {
        context: '',
        analysis,
        allocation: null,
        durationMs: Date.now() - start,
        skipped: true,
        skipReason: 'no_project',
      };
    }

    // 4. Check timeout before heavy work
    if (Date.now() - start > PIPELINE_TIMEOUT_MS) {
      return {
        context: '',
        analysis,
        allocation: null,
        durationMs: Date.now() - start,
        skipped: true,
        skipReason: 'timeout',
      };
    }

    // 5. Fetch, score, allocate, format
    const fetched = fetchContext(db, projectId, analysis);
    const scored = scoreContext(analysis, fetched);
    const allocation = allocateBudget(scored, sessionTurns);
    const context = formatContext(allocation, analysis);

    return {
      context,
      analysis,
      allocation,
      durationMs: Date.now() - start,
      skipped: false,
    };
  } finally {
    db.close();
  }
}

/**
 * Generate the permanent rules file for the current project.
 * Called once at session start, writes to ~/.claude/rules/devbrain-project-context.md
 */
export function generateRulesFile(dbPath?: string): string | null {
  const db = openReadonlyDb(dbPath);
  if (!db) return null;

  try {
    const projectId = resolveProjectId(db);
    if (!projectId) return null;

    // Get project name
    const project = db.prepare(
      'SELECT name FROM projects WHERE id = ?'
    ).get(projectId) as { name: string } | undefined;
    const projectName = project?.name ?? 'Unknown';

    // Fetch must rules
    const ruleRows = db.prepare(`
      SELECT id, content, severity FROM rules
      WHERE project_id = ? AND severity = 'must'
      ORDER BY content LIMIT 10
    `).all(projectId) as Array<{ id: string; content: string; severity: string }>;

    const rules = ruleRows.map(r => ({
      category: 'rule' as const,
      score: 1.0,
      text: `[MUST] ${r.content}`,
      id: r.id,
    }));

    // Fetch top architecture/module/pattern entities by relation count
    const entityRows = db.prepare(`
      SELECT e.id, e.name, e.type, e.content,
        (SELECT COUNT(*) FROM relations WHERE from_entity_id = e.id OR to_entity_id = e.id) as rel_count
      FROM entities e
      WHERE e.project_id = ? AND e.status = 'active'
        AND e.type IN ('architecture', 'module', 'pattern', 'decision')
      ORDER BY rel_count DESC
      LIMIT 5
    `).all(projectId) as Array<{ id: string; name: string; type: string; content: string | null }>;

    const topEntities = entityRows.map(e => ({
      category: 'entity' as const,
      score: 0.9,
      text: `**${e.name}** (${e.type})${e.content ? `: ${e.content}` : ''}`,
      id: e.id,
    }));

    // Fetch last session
    const sessionRow = db.prepare(`
      SELECT goal, summary FROM sessions
      WHERE project_id = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1
    `).get(projectId) as { goal: string; summary: string | null } | undefined;

    const lastSession = sessionRow
      ? [{
          category: 'session' as const,
          score: 0.65,
          text: `Last session goal: ${sessionRow.goal}${sessionRow.summary ? ` — ${sessionRow.summary}` : ''}`,
          id: 'last-session',
        }]
      : [];

    return formatRulesFile(projectName, rules, topEntities, lastSession);
  } finally {
    db.close();
  }
}

export { analyzePrompt } from './prompt-analyzer.js';
export { formatContext, formatRulesFile } from './context-formatter.js';
export type { PromptAnalysis, TokenBudgetAllocation } from './types.js';
