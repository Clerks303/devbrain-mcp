import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Lesson } from '../../types.js';
import { now, parseMetadata } from './helpers.js';

export function toLesson(row: Record<string, unknown>): Lesson {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    trigger: row.trigger_text as string,
    action: row.action as string,
    outcome: (row.outcome as Lesson['outcome']) ?? 'neutral',
    confidence: (row.confidence as number) ?? 0.5,
    occurrences: (row.occurrences as number) ?? 1,
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class LessonRepository {
  constructor(private db: Database.Database) {}

  addLesson(params: {
    projectId: string;
    trigger: string;
    action: string;
    outcome?: Lesson['outcome'];
    metadata?: Record<string, unknown> | null;
  }): Lesson {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO lessons (id, project_id, trigger_text, action, outcome, confidence, occurrences, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0.5, 1, ?, ?, ?)
    `).run(
      id, params.projectId, params.trigger, params.action,
      params.outcome ?? 'neutral',
      params.metadata ? JSON.stringify(params.metadata) : null,
      ts, ts,
    );
    return this.getLesson(id)!;
  }

  getLesson(id: string): Lesson | null {
    const row = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toLesson(row) : null;
  }

  updateLesson(id: string, updates: {
    confidence?: number;
    outcome?: Lesson['outcome'];
    metadata?: Record<string, unknown> | null;
  }): Lesson {
    const existing = this.getLesson(id);
    if (!existing) throw new Error(`Lesson not found: ${id}`);

    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now()];

    if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.outcome !== undefined) { sets.push('outcome = ?'); values.push(updates.outcome); }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    values.push(id);
    this.db.prepare(`UPDATE lessons SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getLesson(id)!;
  }

  reinforceLesson(id: string): Lesson {
    const existing = this.getLesson(id);
    if (!existing) throw new Error(`Lesson not found: ${id}`);
    const newConfidence = Math.min(1.0, existing.confidence + 0.1);
    this.db.prepare(
      'UPDATE lessons SET occurrences = occurrences + 1, confidence = ?, updated_at = ? WHERE id = ?'
    ).run(newConfidence, now(), id);
    return this.getLesson(id)!;
  }

  listLessons(projectId: string, filters?: { outcome?: string; minConfidence?: number; limit?: number; offset?: number }): Lesson[] {
    let sql = 'SELECT * FROM lessons WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (filters?.outcome) { sql += ' AND outcome = ?'; params.push(filters.outcome); }
    if (filters?.minConfidence !== undefined) { sql += ' AND confidence >= ?'; params.push(filters.minConfidence); }
    sql += ' ORDER BY confidence DESC LIMIT ? OFFSET ?';
    params.push(filters?.limit ?? 100, filters?.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toLesson);
  }

  deleteLesson(id: string): void {
    this.db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
  }
}
