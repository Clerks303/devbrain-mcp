import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PromptAnalysis, FetchedContext, FetchedEntity, FetchedRule, FetchedLesson, FetchedIssue, FetchedSession } from './types.js';

const DEVBRAIN_DIR = path.join(os.homedir(), '.devbrain');
const ACTIVE_PROJECT_FILE = path.join(DEVBRAIN_DIR, 'active-project.json');
const DEFAULT_DB_PATH = path.join(DEVBRAIN_DIR, 'devbrain.db');

interface ActiveProject {
  projectId: string;
  projectPath: string;
}

function readActiveProject(): ActiveProject | null {
  try {
    if (!fs.existsSync(ACTIVE_PROJECT_FILE)) return null;
    return JSON.parse(fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf-8')) as ActiveProject;
  } catch {
    return null;
  }
}

/** Resolve project by CWD fallback */
function resolveProjectByCwd(db: Database.Database): string | null {
  const cwd = process.cwd();
  const row = db.prepare(
    `SELECT id FROM projects WHERE ? LIKE path || '%' ORDER BY length(path) DESC LIMIT 1`
  ).get(cwd) as { id: string } | undefined;
  return row?.id ?? null;
}

export function openReadonlyDb(dbPath?: string): Database.Database | null {
  const p = dbPath ?? DEFAULT_DB_PATH;
  if (!fs.existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 200');
    return db;
  } catch {
    return null;
  }
}

export function resolveProjectId(db: Database.Database): string | null {
  const active = readActiveProject();
  if (active?.projectId) return active.projectId;
  return resolveProjectByCwd(db);
}

export function fetchContext(
  db: Database.Database,
  projectId: string,
  analysis: PromptAnalysis,
): FetchedContext {
  const entities = fetchEntities(db, projectId, analysis);
  const rules = fetchRules(db, projectId, analysis);
  const lessons = fetchLessons(db, projectId, analysis);
  const openIssues = fetchOpenIssues(db, projectId);
  const lastSession = fetchLastSession(db, projectId);
  const neighbors = fetchNeighbors(db, projectId, entities);

  return { entities, rules, lessons, openIssues, lastSession, neighbors };
}

// --- Entity search via FTS5 + name match ---

function fetchEntities(
  db: Database.Database,
  projectId: string,
  analysis: PromptAnalysis,
): FetchedEntity[] {
  const results = new Map<string, FetchedEntity>();

  // 1. Name match on mentioned identifiers
  for (const identifier of analysis.mentionedIdentifiers.slice(0, 5)) {
    try {
      const rows = db.prepare(`
        SELECT id, name, type, content, status FROM entities
        WHERE project_id = ? AND name LIKE ? AND status != 'archived'
        LIMIT 3
      `).all(projectId, `%${identifier}%`) as Array<{ id: string; name: string; type: string; content: string | null; status: string }>;

      for (const row of rows) {
        if (!results.has(row.id)) {
          results.set(row.id, { ...row, source: 'name_match' });
        }
      }
    } catch { /* ignore */ }
  }

  // 2. FTS5 search on keywords
  const searchTerms = [...analysis.keywords, ...analysis.mentionedIdentifiers].slice(0, 8);
  if (searchTerms.length > 0) {
    const ftsQuery = searchTerms
      .map(t => t.replace(/['"*():^~{}/\\]/g, ''))
      .filter(Boolean)
      .join(' OR ');

    if (ftsQuery) {
      try {
        const rows = db.prepare(`
          SELECT e.id, e.name, e.type, e.content, e.status
          FROM entities e
          JOIN entities_fts ef ON e.id = ef.rowid
          WHERE ef.entities_fts MATCH ? AND e.project_id = ? AND e.status != 'archived'
          LIMIT 8
        `).all(ftsQuery, projectId) as Array<{ id: string; name: string; type: string; content: string | null; status: string }>;

        for (const row of rows) {
          if (!results.has(row.id)) {
            results.set(row.id, { ...row, source: 'fts' });
          }
        }
      } catch { /* FTS table may not exist */ }
    }
  }

  return [...results.values()].slice(0, 10);
}

// --- Rules ---

function fetchRules(
  db: Database.Database,
  projectId: string,
  analysis: PromptAnalysis,
): FetchedRule[] {
  const rules: FetchedRule[] = [];

  try {
    // Global + must rules always included
    const globalRows = db.prepare(`
      SELECT id, content, severity, scope, pattern FROM rules
      WHERE project_id = ? AND (scope = 'global' OR severity = 'must')
      ORDER BY severity ASC
      LIMIT 10
    `).all(projectId) as FetchedRule[];
    rules.push(...globalRows);

    // File pattern rules matching mentioned files
    if (analysis.mentionedFiles.length > 0) {
      for (const file of analysis.mentionedFiles.slice(0, 3)) {
        const patternRows = db.prepare(`
          SELECT id, content, severity, scope, pattern FROM rules
          WHERE project_id = ? AND scope = 'file_pattern' AND ? LIKE '%' || pattern || '%'
          LIMIT 5
        `).all(projectId, file) as FetchedRule[];

        for (const row of patternRows) {
          if (!rules.some(r => r.id === row.id)) {
            rules.push(row);
          }
        }
      }
    }
  } catch { /* rules table may not exist */ }

  return rules;
}

// --- Lessons ---

function fetchLessons(
  db: Database.Database,
  projectId: string,
  analysis: PromptAnalysis,
): FetchedLesson[] {
  const searchTerms = [...analysis.keywords, ...analysis.mentionedIdentifiers].slice(0, 5);
  if (searchTerms.length === 0) return [];

  try {
    // FTS search on lessons
    const ftsQuery = searchTerms
      .map(t => t.replace(/['"*():^~{}/\\]/g, ''))
      .filter(Boolean)
      .join(' OR ');

    if (!ftsQuery) return [];

    const rows = db.prepare(`
      SELECT l.id, l.trigger, l.action, l.outcome, l.confidence
      FROM lessons l
      JOIN lessons_fts lf ON l.id = lf.rowid
      WHERE lf.lessons_fts MATCH ? AND l.project_id = ? AND l.confidence >= 0.4
      LIMIT 5
    `).all(ftsQuery, projectId) as FetchedLesson[];

    return rows;
  } catch {
    // Fallback: LIKE search
    try {
      const term = searchTerms[0];
      return db.prepare(`
        SELECT id, trigger, action, outcome, confidence FROM lessons
        WHERE project_id = ? AND confidence >= 0.4
          AND (trigger LIKE ? OR action LIKE ?)
        LIMIT 5
      `).all(projectId, `%${term}%`, `%${term}%`) as FetchedLesson[];
    } catch {
      return [];
    }
  }
}

// --- Open Issues ---

function fetchOpenIssues(db: Database.Database, projectId: string): FetchedIssue[] {
  try {
    return db.prepare(`
      SELECT id, title, severity, type FROM issues
      WHERE project_id = ? AND status = 'open'
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 5
    `).all(projectId) as FetchedIssue[];
  } catch {
    return [];
  }
}

// --- Last Session ---

function fetchLastSession(db: Database.Database, projectId: string): FetchedSession | null {
  try {
    const row = db.prepare(`
      SELECT goal, summary, ended_at as endedAt FROM sessions
      WHERE project_id = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1
    `).get(projectId) as FetchedSession | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

// --- Graph Neighbors (depth 1) ---

function fetchNeighbors(
  db: Database.Database,
  projectId: string,
  entities: FetchedEntity[],
): FetchedEntity[] {
  if (entities.length === 0) return [];

  const entityIds = entities.map(e => e.id);
  const neighbors = new Map<string, FetchedEntity>();

  for (const entityId of entityIds.slice(0, 5)) {
    try {
      // Outgoing relations
      const outRows = db.prepare(`
        SELECT e.id, e.name, e.type, e.content, e.status
        FROM entities e
        JOIN relations r ON e.id = r.to_entity_id
        WHERE r.from_entity_id = ? AND e.project_id = ? AND e.status != 'archived'
        LIMIT 3
      `).all(entityId, projectId) as Array<{ id: string; name: string; type: string; content: string | null; status: string }>;

      for (const row of outRows) {
        if (!neighbors.has(row.id) && !entityIds.includes(row.id)) {
          neighbors.set(row.id, { ...row, source: 'name_match' });
        }
      }

      // Incoming relations
      const inRows = db.prepare(`
        SELECT e.id, e.name, e.type, e.content, e.status
        FROM entities e
        JOIN relations r ON e.id = r.from_entity_id
        WHERE r.to_entity_id = ? AND e.project_id = ? AND e.status != 'archived'
        LIMIT 3
      `).all(entityId, projectId) as Array<{ id: string; name: string; type: string; content: string | null; status: string }>;

      for (const row of inRows) {
        if (!neighbors.has(row.id) && !entityIds.includes(row.id)) {
          neighbors.set(row.id, { ...row, source: 'name_match' });
        }
      }
    } catch { /* ignore */ }
  }

  return [...neighbors.values()].slice(0, 5);
}
