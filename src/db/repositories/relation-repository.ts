import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Relation } from '../../types.js';
import { now, parseMetadata } from './helpers.js';

export function toRelation(row: Record<string, unknown>): Relation {
  return {
    id: row.id as string,
    fromEntityId: row.from_entity_id as string,
    toEntityId: row.to_entity_id as string,
    type: row.type as string,
    weight: row.weight as number,
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
  };
}

export class RelationRepository {
  constructor(private db: Database.Database) {}

  addRelation(params: {
    fromEntityId: string;
    toEntityId: string;
    type: string;
    weight?: number;
    metadata?: Record<string, unknown> | null;
  }): Relation {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO relations (id, from_entity_id, to_entity_id, type, weight, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.fromEntityId,
      params.toEntityId,
      params.type,
      params.weight ?? 1.0,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now(),
    );
    return this.getRelation(id)!;
  }

  getRelation(id: string): Relation | null {
    const row = this.db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRelation(row) : null;
  }

  getRelations(entityId: string, direction: 'from' | 'to' | 'both' = 'both'): Relation[] {
    if (direction === 'from') {
      return (this.db.prepare('SELECT * FROM relations WHERE from_entity_id = ?').all(entityId) as Record<string, unknown>[]).map(toRelation);
    }
    if (direction === 'to') {
      return (this.db.prepare('SELECT * FROM relations WHERE to_entity_id = ?').all(entityId) as Record<string, unknown>[]).map(toRelation);
    }
    return (this.db.prepare(
      'SELECT * FROM relations WHERE from_entity_id = ? OR to_entity_id = ?'
    ).all(entityId, entityId) as Record<string, unknown>[]).map(toRelation);
  }

  deleteRelation(id: string): void {
    this.db.prepare('DELETE FROM relations WHERE id = ?').run(id);
  }
}
