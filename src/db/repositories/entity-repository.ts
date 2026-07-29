import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Entity } from '../../types.js';
import { encodeCursor, decodeCursor, type Page } from '../pagination.js';
import { now, parseMetadata } from './helpers.js';

export function toEntity(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    projectId: (row.project_id as string) ?? null,
    content: (row.content as string) ?? null,
    metadata: parseMetadata(row.metadata as string | null),
    status: (row.status as string) ?? 'unknown',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class EntityRepository {
  constructor(private db: Database.Database) {}

  addEntity(params: {
    name: string;
    type: string;
    projectId?: string | null;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    status?: string;
  }): Entity {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO entities (id, name, type, project_id, content, metadata, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.name,
      params.type,
      params.projectId ?? null,
      params.content ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.status ?? 'unknown',
      ts,
      ts,
    );
    return this.getEntity(id)!;
  }

  getEntity(id: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toEntity(row) : null;
  }

  updateEntity(id: string, updates: {
    name?: string;
    type?: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    status?: string;
  }): Entity {
    const existing = this.getEntity(id);
    if (!existing) throw new Error(`Entity not found: ${id}`);

    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now()];

    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type); }
    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }

    values.push(id);
    this.db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getEntity(id)!;
  }

  deleteEntity(id: string): void {
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  }

  // Batch lookup helpers — eliminate N+1 in hybridSearch and other multi-hit
  // paths. Each method does a single round-trip. better-sqlite3 ships with
  // SQLite ≥ 3.43 where SQLITE_MAX_VARIABLE_NUMBER is 32766, so chunking
  // isn't needed in practice (current callers cap at hundreds of ids).

  getEntitiesByIds(
    ids: readonly string[],
    filters?: { projectId?: string | null; types?: readonly string[] },
  ): Entity[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const params: unknown[] = [...ids];
    let sql = `SELECT * FROM entities WHERE id IN (${placeholders})`;
    if (filters?.projectId) {
      sql += ' AND (project_id = ? OR project_id IS NULL)';
      params.push(filters.projectId);
    }
    if (filters?.types && filters.types.length > 0) {
      const typePlaceholders = filters.types.map(() => '?').join(',');
      sql += ` AND type IN (${typePlaceholders})`;
      params.push(...filters.types);
    }
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEntity);
  }

  listEntities(projectId?: string | null, type?: string, limit: number = 100, offset: number = 0): Entity[] {
    let sql = 'SELECT * FROM entities WHERE 1=1';
    const params: unknown[] = [];

    if (projectId !== undefined) {
      if (projectId === null) {
        sql += ' AND project_id IS NULL';
      } else {
        sql += ' AND (project_id = ? OR project_id IS NULL)';
        params.push(projectId);
      }
    }
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEntity);
  }

  findEntitiesByName(name: string, projectId?: string | null): Entity[] {
    // Try FTS5 first for better performance
    try {
      const ftsResults = this.findEntitiesByNameFts(name, projectId);
      if (ftsResults.length > 0) {
        return ftsResults;
      }
    } catch {
      // FTS5 table missing or query error -- fall through to LIKE
    }
    // Fallback to LIKE for substring matching (FTS5 only does prefix/token matching)
    return this.findEntitiesByNameLike(name, projectId);
  }

  private findEntitiesByNameFts(name: string, projectId?: string | null): Entity[] {
    // Escape FTS5 special characters (including boolean operators - and +,
    // which would otherwise invert or alter the match) and use prefix search
    const ftsQuery = name.replace(/['"*():^~{}/\\+-]/g, '');
    if (!ftsQuery.trim()) {
      return [];
    }

    let sql = `
      SELECT e.* FROM entities e
      INNER JOIN entities_fts fts ON e.rowid = fts.rowid
      WHERE entities_fts MATCH ?
    `;
    // Use column filter on name for targeted search
    const params: unknown[] = [`name:${ftsQuery}*`];

    if (projectId !== undefined) {
      if (projectId === null) {
        sql += ' AND e.project_id IS NULL';
      } else {
        sql += ' AND (e.project_id = ? OR e.project_id IS NULL)';
        params.push(projectId);
      }
    }

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEntity);
  }

  private findEntitiesByNameLike(name: string, projectId?: string | null): Entity[] {
    let sql = 'SELECT * FROM entities WHERE name LIKE ?';
    const params: unknown[] = [`%${name}%`];

    if (projectId !== undefined) {
      if (projectId === null) {
        sql += ' AND project_id IS NULL';
      } else {
        sql += ' AND (project_id = ? OR project_id IS NULL)';
        params.push(projectId);
      }
    }

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEntity);
  }

  // --- Cursor-based pagination ---
  //
  // Returns Page<T> with an opaque nextCursor. Use on lists that can grow
  // beyond ~10k rows. The offset/limit listEntities remains for small lists.

  listEntitiesPage(
    projectId: string | null | undefined,
    opts: { type?: string; limit?: number; cursor?: string | null } = {},
  ): Page<Entity> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const params: unknown[] = [];
    let sql = 'SELECT * FROM entities WHERE 1=1';

    if (projectId !== undefined) {
      if (projectId === null) {
        sql += ' AND project_id IS NULL';
      } else {
        sql += ' AND (project_id = ? OR project_id IS NULL)';
        params.push(projectId);
      }
    }
    if (opts.type) {
      sql += ' AND type = ?';
      params.push(opts.type);
    }

    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      if (c) {
        // Row value comparison — SQLite compares lexicographically, so this
        // implements (updated_at, id) < (?, ?) which keeps ordering stable
        // across rows that share the same updated_at.
        sql += ' AND (updated_at, id) < (?, ?)';
        params.push(c.ts, c.id);
      }
    }

    // Fetch limit+1 so we know whether more rows exist without a COUNT.
    sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEntity);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ ts: last.updatedAt, id: last.id })
      : null;
    return { items, nextCursor };
  }
}
