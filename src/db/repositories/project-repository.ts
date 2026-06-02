import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Project } from '../../types.js';
import { now, parseMetadata } from './helpers.js';

export function toProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    path: (row.path as string) ?? null,
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
  };
}

export class ProjectRepository {
  constructor(private db: Database.Database) {}

  addProject(params: { name: string; path?: string | null; metadata?: Record<string, unknown> | null }): Project {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO projects (id, name, path, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      id,
      params.name,
      params.path ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now(),
    );
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toProject(row) : null;
  }

  getProjectByPath(projectPath: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath) as Record<string, unknown> | undefined;
    return row ? toProject(row) : null;
  }

  listProjects(limit: number = 100, offset: number = 0): Project[] {
    return (this.db.prepare(
      'SELECT * FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as Record<string, unknown>[]).map(toProject);
  }
}
