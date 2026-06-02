import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { FileDigest, StalenessResult } from '../../types.js';
import { now, parseMetadata, parseJsonArray } from './helpers.js';

export function toFileDigest(row: Record<string, unknown>): FileDigest {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    path: row.path as string,
    contentHash: (row.content_hash as string) ?? null,
    summary: (row.summary as string) ?? null,
    exports: parseJsonArray(row.exports as string | null),
    imports: parseJsonArray(row.imports as string | null),
    language: (row.language as string) ?? null,
    loc: (row.loc as number) ?? null,
    status: (row.status as string) ?? 'active',
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class FileDigestRepository {
  constructor(private db: Database.Database) {}

  upsertFileDigest(params: {
    projectId: string;
    path: string;
    contentHash?: string | null;
    summary?: string | null;
    exports?: string[];
    imports?: string[];
    language?: string | null;
    loc?: number | null;
    status?: string;
    metadata?: Record<string, unknown> | null;
  }): FileDigest {
    const ts = now();
    const existing = this.getFileDigestByPath(params.projectId, params.path);

    if (existing) {
      const sets: string[] = ['updated_at = ?'];
      const values: unknown[] = [ts];

      if (params.contentHash !== undefined) { sets.push('content_hash = ?'); values.push(params.contentHash ?? null); }
      if (params.summary !== undefined) { sets.push('summary = ?'); values.push(params.summary ?? null); }
      if (params.exports !== undefined) { sets.push('exports = ?'); values.push(JSON.stringify(params.exports)); }
      if (params.imports !== undefined) { sets.push('imports = ?'); values.push(JSON.stringify(params.imports)); }
      if (params.language !== undefined) { sets.push('language = ?'); values.push(params.language ?? null); }
      if (params.loc !== undefined) { sets.push('loc = ?'); values.push(params.loc ?? null); }
      if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }
      if (params.metadata !== undefined) {
        sets.push('metadata = ?');
        values.push(params.metadata ? JSON.stringify(params.metadata) : null);
      }

      values.push(existing.id);
      this.db.prepare(`UPDATE file_digests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return this.getFileDigest(existing.id)!;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO file_digests (id, project_id, path, content_hash, summary, exports, imports, language, loc, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.path,
      params.contentHash ?? null,
      params.summary ?? null,
      params.exports ? JSON.stringify(params.exports) : null,
      params.imports ? JSON.stringify(params.imports) : null,
      params.language ?? null,
      params.loc ?? null,
      params.status ?? 'active',
      params.metadata ? JSON.stringify(params.metadata) : null,
      ts,
      ts,
    );
    return this.getFileDigest(id)!;
  }

  getFileDigest(id: string): FileDigest | null {
    const row = this.db.prepare('SELECT * FROM file_digests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toFileDigest(row) : null;
  }

  getFileDigestByPath(projectId: string, filePath: string): FileDigest | null {
    const row = this.db.prepare('SELECT * FROM file_digests WHERE project_id = ? AND path = ?').get(projectId, filePath) as Record<string, unknown> | undefined;
    return row ? toFileDigest(row) : null;
  }

  listFileDigests(projectId: string, filters?: { status?: string; language?: string; limit?: number; offset?: number }): FileDigest[] {
    let sql = 'SELECT * FROM file_digests WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters?.language) { sql += ' AND language = ?'; params.push(filters.language); }
    sql += ' ORDER BY path ASC LIMIT ? OFFSET ?';
    params.push(filters?.limit ?? 100, filters?.offset ?? 0);

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toFileDigest);
  }

  checkFilesStaleness(projectId: string, files: { path: string; hash: string }[]): StalenessResult[] {
    return files.map(f => {
      const digest = this.getFileDigestByPath(projectId, f.path);
      return {
        path: f.path,
        currentHash: digest?.contentHash ?? null,
        providedHash: f.hash,
        isStale: !digest || digest.contentHash !== f.hash,
      };
    });
  }

  deleteFileDigest(id: string): void {
    this.db.prepare('DELETE FROM file_digests WHERE id = ?').run(id);
  }
}
