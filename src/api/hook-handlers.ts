import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DevBrain } from '../server.js';
import { getAutoContext } from '../graph/context-auto.js';

const DEVBRAIN_DIR = path.join(os.homedir(), '.devbrain');
const SESSIONS_DIR = path.join(DEVBRAIN_DIR, 'sessions');
const ACTIVE_PROJECT_FILE = path.join(DEVBRAIN_DIR, 'active-project.json');

interface ActiveProjectInfo {
  readonly projectId: string;
  readonly projectPath: string;
  readonly projectName: string;
  readonly setAt: string;
}

interface CurrentSessionInfo {
  readonly sessionId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly startedAt: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeActiveProject(info: ActiveProjectInfo): void {
  ensureDir(DEVBRAIN_DIR);
  fs.writeFileSync(ACTIVE_PROJECT_FILE, JSON.stringify(info, null, 2));
}

function writeCurrentSession(info: CurrentSessionInfo): void {
  ensureDir(SESSIONS_DIR);
  fs.writeFileSync(path.join(SESSIONS_DIR, 'current.json'), JSON.stringify(info, null, 2));
}

function readCurrentSession(): CurrentSessionInfo | null {
  const filePath = path.join(SESSIONS_DIR, 'current.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CurrentSessionInfo;
  } catch {
    return null;
  }
}

function removeCurrentSession(): void {
  const filePath = path.join(SESSIONS_DIR, 'current.json');
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

/** Detect project from cwd by walking up to find a match in registered projects */
function detectProject(brain: DevBrain, cwd: string): { id: string; name: string; path: string } | null {
  // Normalize path
  const normalizedCwd = path.resolve(cwd);

  // Try exact match first, then walk up
  let dir = normalizedCwd;
  const root = path.parse(dir).root;

  while (dir !== root) {
    const project = brain.store.getProjectByPath(dir);
    if (project && project.path) {
      return { id: project.id, name: project.name, path: project.path };
    }
    dir = path.dirname(dir);
  }

  return null;
}

// --- Debounce tracking for post-tool digest ---
const digestTimestamps = new Map<string, number>();
const DIGEST_DEBOUNCE_MS = 2000;

function shouldDigest(filePath: string): boolean {
  const now = Date.now();
  const last = digestTimestamps.get(filePath);
  if (last && now - last < DIGEST_DEBOUNCE_MS) return false;
  digestTimestamps.set(filePath, now);
  return true;
}

// Tools that trigger file digest
const DIGEST_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// Tools we completely ignore (read-only, no side effects)
const IGNORED_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch',
  'AskUserQuestion', 'TodoRead', 'TodoWrite', 'TaskCreate',
  'TaskUpdate', 'TaskList', 'TaskGet',
]);

// ─────────────────────────────────────────────
// Handler: session-start
// ─────────────────────────────────────────────

export interface SessionStartResult {
  readonly ok: boolean;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly sessionId?: string;
  readonly context?: string;
  readonly error?: string;
}

export async function handleSessionStart(
  brain: DevBrain,
  body: Record<string, unknown>,
): Promise<SessionStartResult> {
  const cwd = typeof body.cwd === 'string' ? body.cwd : null;
  if (!cwd) {
    return { ok: false, error: 'Missing cwd' };
  }

  // If there's already an active session, don't create another (idempotent)
  if (brain.activeSessionId) {
    const currentSession = readCurrentSession();
    return {
      ok: true,
      projectId: brain.activeProjectId ?? undefined,
      sessionId: brain.activeSessionId,
      context: currentSession ? `Session already active: ${currentSession.goal}` : undefined,
    };
  }

  // 1. Detect project
  const detected = detectProject(brain, cwd);
  if (!detected) {
    return { ok: false, error: `No registered project found for: ${cwd}` };
  }

  // 2. Set active project
  brain.activeProjectId = detected.id;

  // 3. Write active-project.json for other phases
  writeActiveProject({
    projectId: detected.id,
    projectPath: detected.path,
    projectName: detected.name,
    setAt: new Date().toISOString(),
  });

  // 4. Start session
  const goal = typeof body.goal === 'string' ? body.goal : `Session on ${detected.name}`;
  const session = brain.store.startSession({ projectId: detected.id, goal });
  brain.activeSessionId = session.id;

  // Embed session goal (non-blocking). Failures are logged but don't
  // abort session start — semantic search on this session goal will be
  // unavailable until the next reindex.
  brain.embeddingProvider.embed(goal).then((embedding) => {
    if (embedding.length > 0) {
      brain.vectorStore.upsertSessionEmbedding(session.id, embedding);
    }
  }).catch((err) => {
    console.error(`[hook:session-start:embed] ${err instanceof Error ? err.message : String(err)}`);
  });

  // 5. Write current session file
  writeCurrentSession({
    sessionId: session.id,
    projectId: detected.id,
    goal,
    startedAt: session.startedAt,
  });

  // 6. Get auto-context
  let contextReport = '';
  try {
    const result = await getAutoContext(
      brain.store, brain.vectorStore, brain.embeddingProvider, detected.id,
      { query: goal, limit: 5 },
    );

    const sections: string[] = [];
    if (result.rules.length > 0) {
      sections.push('## Rules\n' + result.rules.map(r =>
        `- [${r.severity.toUpperCase()}] ${r.content}`
      ).join('\n'));
    }
    if (result.entities.length > 0) {
      sections.push('## Relevant Context\n' + result.entities.map(e =>
        `- **${e.entity.name}** (${e.entity.type})${e.entity.content ? `: ${e.entity.content}` : ''}`
      ).join('\n'));
    }
    if (result.lessons.length > 0) {
      sections.push('## Lessons\n' + result.lessons.map(l =>
        `- [${l.outcome}] "${l.trigger}" → ${l.action}`
      ).join('\n'));
    }
    if (result.openIssues.length > 0) {
      sections.push('## Open Issues\n' + result.openIssues.map(i =>
        `- [${i.severity}] ${i.title}`
      ).join('\n'));
    }
    if (result.lastSession) {
      const s = result.lastSession;
      sections.push(`## Last Session\n- Goal: ${s.goal}${s.summary ? `\n- Summary: ${s.summary}` : ''}`);
    }
    if (sections.length > 0) {
      contextReport = sections.join('\n\n');
    }
  } catch (err) {
    // Auto-context is non-critical (session still starts), but the silent
    // swallow used to mask Zod validation bugs and embed-provider outages
    // for hours. Log so the failure is visible in MCP server logs.
    console.error(`[hook:session-start:auto-context] ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ok: true,
    projectId: detected.id,
    projectName: detected.name,
    sessionId: session.id,
    context: contextReport || undefined,
  };
}

// ─────────────────────────────────────────────
// Handler: post-tool
// ─────────────────────────────────────────────

export interface PostToolResult {
  readonly ok: boolean;
  readonly action?: string;
  readonly error?: string;
}

export async function handlePostTool(
  brain: DevBrain,
  body: Record<string, unknown>,
): Promise<PostToolResult> {
  const toolName = typeof body.tool_name === 'string' ? body.tool_name : null;
  if (!toolName) {
    return { ok: false, error: 'Missing tool_name' };
  }

  // Ignore read-only tools
  if (IGNORED_TOOLS.has(toolName)) {
    return { ok: true, action: 'ignored' };
  }

  const sessionId = brain.activeSessionId;
  const projectId = brain.activeProjectId;

  if (!sessionId || !projectId) {
    return { ok: true, action: 'no_session' };
  }

  // Log tool call event
  try {
    brain.store.addSessionEvent({
      sessionId,
      type: 'tool_call',
      content: `${toolName}${typeof body.tool_input === 'object' ? '' : ''}`,
      toolName,
    });
    brain.store.updateSessionCounters(sessionId, { toolCalls: 1 });
  } catch (err) {
    console.error('[hook-handlers] Failed to log tool event:', err);
  }

  // Digest file for write operations
  if (DIGEST_TOOLS.has(toolName)) {
    const input = body.tool_input as Record<string, unknown> | undefined;
    const filePath = typeof input?.file_path === 'string'
      ? input.file_path
      : typeof input?.path === 'string'
        ? input.path
        : null;

    if (filePath && shouldDigest(filePath)) {
      try {
        // Find project path to compute relative path
        const projects = brain.store.listProjects();
        const currentProject = projects.find(p => p.id === projectId);
        const projectPath = currentProject?.path ?? '';
        const relativePath = projectPath
          ? path.relative(projectPath, filePath)
          : filePath;

        brain.store.upsertFileDigest({
          projectId,
          path: relativePath,
          contentHash: null,
          summary: null,
          exports: undefined,
          imports: undefined,
          language: detectLanguage(filePath),
          loc: null,
          status: undefined,
          metadata: { source: 'hook', toolName },
        });

        return { ok: true, action: 'digested' };
      } catch (err) {
        console.error('[hook-handlers] Failed to digest file:', err);
      }
    }

    return { ok: true, action: 'debounced' };
  }

  return { ok: true, action: 'logged' };
}

function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.rs': 'rust', '.go': 'go',
    '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    '.rb': 'ruby', '.php': 'php', '.cs': 'csharp',
    '.css': 'css', '.scss': 'scss', '.html': 'html',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.sql': 'sql', '.sh': 'shell',
  };
  return langMap[ext] ?? null;
}

// ─────────────────────────────────────────────
// Handler: session-end
// ─────────────────────────────────────────────

export interface SessionEndResult {
  readonly ok: boolean;
  readonly sessionId?: string;
  readonly summary?: string;
  readonly error?: string;
}

export async function handleSessionEnd(
  brain: DevBrain,
  body: Record<string, unknown>,
): Promise<SessionEndResult> {
  // Read session ID from body or from current.json
  let sessionId = typeof body.session_id === 'string' ? body.session_id : null;

  if (!sessionId) {
    const current = readCurrentSession();
    sessionId = current?.sessionId ?? brain.activeSessionId;
  }

  if (!sessionId) {
    return { ok: false, error: 'No active session to end' };
  }

  const session = brain.store.getSession(sessionId);
  if (!session) {
    removeCurrentSession();
    return { ok: false, error: `Session not found: ${sessionId}` };
  }

  // Generate summary from session events
  const events = brain.store.getSessionEvents(sessionId);
  const summary = generateSessionSummary(session.goal, events);

  // End session
  brain.store.endSession(sessionId, summary);

  if (brain.activeSessionId === sessionId) {
    brain.activeSessionId = null;
  }

  // Re-embed with summary for better future search. Failures logged but
  // don't abort session end — search will use the older embedding.
  const text = [session.goal, summary].filter(Boolean).join(' — ');
  brain.embeddingProvider.embed(text).then((embedding) => {
    if (embedding.length > 0) {
      brain.vectorStore.upsertSessionEmbedding(sessionId, embedding);
    }
  }).catch((err) => {
    console.error(`[hook:session-end:embed] ${err instanceof Error ? err.message : String(err)}`);
  });

  // Cleanup
  removeCurrentSession();

  return {
    ok: true,
    sessionId,
    summary,
  };
}

interface MinimalEvent {
  readonly type: string;
  readonly content: string;
  readonly toolName: string | null;
}

function generateSessionSummary(goal: string, events: readonly MinimalEvent[]): string {
  const toolCalls = events.filter(e => e.type === 'tool_call');
  const decisions = events.filter(e => e.type === 'decision');
  const discoveries = events.filter(e => e.type === 'discovery');
  const errors = events.filter(e => e.type === 'error');

  // Count unique tools used
  const uniqueTools = new Set(toolCalls.map(e => e.toolName).filter(Boolean));

  // Build summary parts
  const parts: string[] = [`Goal: ${goal}`];

  if (uniqueTools.size > 0) {
    parts.push(`Tools used: ${[...uniqueTools].join(', ')} (${toolCalls.length} calls)`);
  }

  if (decisions.length > 0) {
    parts.push(`Decisions: ${decisions.map(d => d.content).join('; ')}`);
  }

  if (discoveries.length > 0) {
    parts.push(`Discoveries: ${discoveries.map(d => d.content).join('; ')}`);
  }

  if (errors.length > 0) {
    parts.push(`Errors encountered: ${errors.length}`);
  }

  return parts.join('. ');
}
