import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Observation } from '../../types.js';
import { now } from './helpers.js';

export function toObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    content: row.content as string,
    source: (row.source as string) ?? null,
    category: (row.category as string) ?? 'note',
    createdAt: row.created_at as string,
  };
}

export class ObservationRepository {
  constructor(private db: Database.Database) {}

  addObservation(params: {
    entityId: string;
    content: string;
    source?: string | null;
    category?: string;
  }): Observation {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO observations (id, entity_id, content, source, category, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, params.entityId, params.content, params.source ?? null, params.category ?? 'note', now());
    return this.getObservation(id)!;
  }

  getObservation(id: string): Observation | null {
    const row = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toObservation(row) : null;
  }

  getObservations(entityId: string): Observation[] {
    return (this.db.prepare(
      'SELECT * FROM observations WHERE entity_id = ? ORDER BY created_at DESC'
    ).all(entityId) as Record<string, unknown>[]).map(toObservation);
  }

  deleteObservation(id: string): void {
    this.db.prepare('DELETE FROM observations WHERE id = ?').run(id);
  }

  // Batch lookups — eliminate N+1 in hybridSearch and other multi-hit paths.

  getObservationsGroupedByEntityIds(entityIds: readonly string[]): Map<string, Observation[]> {
    const grouped = new Map<string, Observation[]>();
    if (entityIds.length === 0) return grouped;
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM observations WHERE entity_id IN (${placeholders})`,
    ).all(...entityIds) as Record<string, unknown>[];
    for (const row of rows) {
      const obs = toObservation(row);
      const list = grouped.get(obs.entityId);
      if (list) list.push(obs);
      else grouped.set(obs.entityId, [obs]);
    }
    return grouped;
  }

  getObservationEntityIds(ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, entity_id FROM observations WHERE id IN (${placeholders})`,
    ).all(...ids) as { id: string; entity_id: string }[];
    for (const r of rows) out.set(r.id, r.entity_id);
    return out;
  }
}
