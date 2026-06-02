import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Issue } from '../../types.js';
import { encodeCursor, decodeCursor, type Page } from '../pagination.js';
import { now, parseMetadata } from './helpers.js';

export function toIssue(row: Record<string, unknown>): Issue {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    entityId: (row.entity_id as string) ?? null,
    filePath: (row.file_path as string) ?? null,
    type: row.type as string,
    title: row.title as string,
    description: (row.description as string) ?? null,
    severity: (row.severity as string) ?? 'medium',
    status: (row.status as string) ?? 'open',
    resolution: (row.resolution as string) ?? null,
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class IssueRepository {
  constructor(private db: Database.Database) {}

  addIssue(params: {
    projectId: string;
    type: string;
    title: string;
    description?: string | null;
    severity?: string;
    entityId?: string | null;
    filePath?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Issue {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO issues (id, project_id, entity_id, file_path, type, title, description, severity, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.entityId ?? null,
      params.filePath ?? null,
      params.type,
      params.title,
      params.description ?? null,
      params.severity ?? 'medium',
      params.metadata ? JSON.stringify(params.metadata) : null,
      ts,
      ts,
    );
    return this.getIssue(id)!;
  }

  getIssue(id: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toIssue(row) : null;
  }

  updateIssue(id: string, updates: {
    title?: string;
    description?: string | null;
    severity?: string;
    status?: string;
    resolution?: string | null;
    entityId?: string | null;
    filePath?: string | null;
    type?: string;
    metadata?: Record<string, unknown> | null;
  }): Issue {
    const existing = this.getIssue(id);
    if (!existing) throw new Error(`Issue not found: ${id}`);

    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now()];

    if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
    if (updates.severity !== undefined) { sets.push('severity = ?'); values.push(updates.severity); }
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.resolution !== undefined) { sets.push('resolution = ?'); values.push(updates.resolution); }
    if (updates.entityId !== undefined) { sets.push('entity_id = ?'); values.push(updates.entityId); }
    if (updates.filePath !== undefined) { sets.push('file_path = ?'); values.push(updates.filePath); }
    if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type); }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    values.push(id);
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getIssue(id)!;
  }

  listIssues(projectId: string, filters?: { type?: string; severity?: string; status?: string; entityId?: string; filePath?: string; limit?: number; offset?: number }): Issue[] {
    let sql = 'SELECT * FROM issues WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filters?.type) { sql += ' AND type = ?'; params.push(filters.type); }
    if (filters?.severity) { sql += ' AND severity = ?'; params.push(filters.severity); }
    if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters?.entityId) { sql += ' AND entity_id = ?'; params.push(filters.entityId); }
    if (filters?.filePath) { sql += ' AND file_path = ?'; params.push(filters.filePath); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(filters?.limit ?? 100, filters?.offset ?? 0);

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toIssue);
  }

  getIssueEntityIds(ids: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, entity_id FROM issues WHERE id IN (${placeholders})`,
    ).all(...ids) as { id: string; entity_id: string | null }[];
    for (const r of rows) out.set(r.id, r.entity_id);
    return out;
  }

  deleteIssue(id: string): void {
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  }

  listIssuesPage(
    projectId: string,
    opts: {
      type?: string;
      severity?: string;
      status?: string;
      entityId?: string;
      filePath?: string;
      limit?: number;
      cursor?: string | null;
    } = {},
  ): Page<Issue> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const params: unknown[] = [projectId];
    let sql = 'SELECT * FROM issues WHERE project_id = ?';

    if (opts.type) { sql += ' AND type = ?'; params.push(opts.type); }
    if (opts.severity) { sql += ' AND severity = ?'; params.push(opts.severity); }
    if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
    if (opts.entityId) { sql += ' AND entity_id = ?'; params.push(opts.entityId); }
    if (opts.filePath) { sql += ' AND file_path = ?'; params.push(opts.filePath); }

    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      if (c) {
        sql += ' AND (created_at, id) < (?, ?)';
        params.push(c.ts, c.id);
      }
    }

    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toIssue);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ ts: last.createdAt, id: last.id })
      : null;
    return { items, nextCursor };
  }
}
