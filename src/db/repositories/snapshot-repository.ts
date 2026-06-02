import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../../types.js';
import { SnapshotPayloadSchema, SnapshotCorruptedError } from '../snapshot-schema.js';
import { now } from './helpers.js';
import { toEntity } from './entity-repository.js';
import { toRelation } from './relation-repository.js';
import { toObservation } from './observation-repository.js';
import type { FileDigestRepository } from './file-digest-repository.js';
import type { IssueRepository } from './issue-repository.js';
import type { RuleRepository } from './rule-repository.js';
import type { LessonRepository } from './lesson-repository.js';

export function toSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    label: row.label as string,
    description: (row.description as string) ?? null,
    data: row.data as string,
    entityCount: (row.entity_count as number) ?? 0,
    relationCount: (row.relation_count as number) ?? 0,
    createdAt: row.created_at as string,
  };
}

export interface SnapshotRepositoryDeps {
  fileDigests: FileDigestRepository;
  issues: IssueRepository;
  rules: RuleRepository;
  lessons: LessonRepository;
}

export class SnapshotRepository {
  constructor(private db: Database.Database, private deps: SnapshotRepositoryDeps) {}

  createSnapshot(projectId: string, label: string, description?: string | null): Snapshot {
    const id = randomUUID();
    const ts = now();

    // Snapshot the entire project — fetch without the listEntities default
    // limit (100), which would silently truncate large projects. Two N+1
    // loops over entities (relations + observations) collapsed into single
    // project-scoped queries.
    //
    // Strict project scoping: entities/relations/observations match
    // `project_id = ?` only (not `OR project_id IS NULL`). Global entities
    // (project_id NULL) belong to no project and would not round-trip
    // cleanly — restoreSnapshot's pre-restore DELETE is also strict
    // (`WHERE project_id = ?`), so including globals previously asymmetric.
    // This aligns entity scoping with rules/issues/lessons (NOT NULL FKs).
    const entities = (this.db.prepare(
      `SELECT * FROM entities WHERE project_id = ? ORDER BY updated_at DESC`,
    ).all(projectId) as Record<string, unknown>[]).map(toEntity);

    const relations = (this.db.prepare(
      `SELECT * FROM relations WHERE from_entity_id IN (
         SELECT id FROM entities WHERE project_id = ?
       )`,
    ).all(projectId) as Record<string, unknown>[]).map(toRelation);

    const observations = (this.db.prepare(
      `SELECT * FROM observations WHERE entity_id IN (
         SELECT id FROM entities WHERE project_id = ?
       )`,
    ).all(projectId) as Record<string, unknown>[]).map(toObservation);

    // These tables are always created by initDatabase(); a failure here is a real error
    // (lock contention, schema drift, corruption). Swallowing it would silently produce
    // an incomplete snapshot that, when later restored, would wipe live data with [].
    // Override the default limit (100) with an effectively-unbounded one — a snapshot
    // that silently drops the 101st rule on restore is a data-loss bug.
    const SNAPSHOT_LIMIT = 1_000_000;
    const fileDigests = this.deps.fileDigests.listFileDigests(projectId, { limit: SNAPSHOT_LIMIT });
    const issues = this.deps.issues.listIssues(projectId, { limit: SNAPSHOT_LIMIT });
    const rules = this.deps.rules.listRules(projectId, undefined, SNAPSHOT_LIMIT);
    const lessons = this.deps.lessons.listLessons(projectId, { limit: SNAPSHOT_LIMIT });

    const data = JSON.stringify({ entities, relations, observations, fileDigests, issues, rules, lessons });

    this.db.prepare(`
      INSERT INTO snapshots (id, project_id, label, description, data, entity_count, relation_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, label, description ?? null, data, entities.length, relations.length, ts);

    return this.getSnapshot(id)!;
  }

  getSnapshot(id: string): Snapshot | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toSnapshot(row) : null;
  }

  listSnapshots(projectId: string, limit: number = 100, offset: number = 0): Omit<Snapshot, 'data'>[] {
    return (this.db.prepare(
      "SELECT id, project_id, label, description, entity_count, relation_count, created_at FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(projectId, limit, offset) as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      projectId: row.project_id as string,
      label: row.label as string,
      description: (row.description as string) ?? null,
      entityCount: (row.entity_count as number) ?? 0,
      relationCount: (row.relation_count as number) ?? 0,
      createdAt: row.created_at as string,
    }));
  }

  deleteSnapshot(id: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  restoreSnapshot(projectId: string, snapshotId: string): Record<string, number> {
    const snap = this.db.prepare('SELECT data FROM snapshots WHERE id = ?').get(snapshotId) as { data: string } | undefined;
    if (!snap) throw new Error(`Snapshot not found: ${snapshotId}`);

    // Parse + validate the payload before touching live data. The restore is a
    // DELETE-then-INSERT cycle wrapped in a transaction; a malformed payload
    // would silently insert NULLs (corrupting the project) or throw mid-way
    // (rolling back, but only after the user already triggered a destructive op).
    let rawData: unknown;
    try {
      rawData = JSON.parse(snap.data);
    } catch (err) {
      throw new SnapshotCorruptedError(snapshotId, [`payload is not valid JSON: ${(err as Error).message}`]);
    }

    const parsed = SnapshotPayloadSchema.safeParse(rawData);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`);
      throw new SnapshotCorruptedError(snapshotId, issues);
    }
    const data = parsed.data;

    const doRestore = this.db.transaction(() => {
      // DELETE in dependency order (CASCADE handles observations/relations from entities)
      this.db.prepare('DELETE FROM lessons WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM rules WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM issues WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM file_digests WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM entities WHERE project_id = ?').run(projectId);

      for (const e of data.entities ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO entities (id, name, type, project_id, content, metadata, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e.id, e.name, e.type, e.projectId ?? null, e.content ?? null,
               e.metadata ? JSON.stringify(e.metadata) : null, e.status ?? 'unknown',
               e.createdAt, e.updatedAt);
      }

      for (const o of data.observations ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO observations (id, entity_id, content, source, category, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(o.id, o.entityId, o.content, o.source ?? null, o.category ?? 'note', o.createdAt);
      }

      for (const r of data.relations ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO relations (id, from_entity_id, to_entity_id, type, weight, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(r.id, r.fromEntityId, r.toEntityId, r.type, r.weight ?? 1.0,
               r.metadata ? JSON.stringify(r.metadata) : null, r.createdAt);
      }

      for (const f of data.fileDigests ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO file_digests (id, project_id, path, content_hash, summary, exports, imports, language, loc, status, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(f.id, f.projectId, f.path, f.contentHash ?? null, f.summary ?? null,
               f.exports ? JSON.stringify(f.exports) : null, f.imports ? JSON.stringify(f.imports) : null,
               f.language ?? null, f.loc ?? null, f.status ?? 'active',
               f.metadata ? JSON.stringify(f.metadata) : null, f.createdAt, f.updatedAt);
      }

      for (const r of data.rules ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO rules (id, project_id, scope, pattern, content, severity, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(r.id, r.projectId, r.scope ?? 'global', r.pattern ?? null, r.content,
               r.severity ?? 'should', r.metadata ? JSON.stringify(r.metadata) : null,
               r.createdAt, r.updatedAt);
      }

      for (const l of data.lessons ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO lessons (id, project_id, trigger_text, action, outcome, confidence, occurrences, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(l.id, l.projectId, l.trigger, l.action, l.outcome ?? 'neutral',
               l.confidence ?? 0.5, l.occurrences ?? 1,
               l.metadata ? JSON.stringify(l.metadata) : null, l.createdAt, l.updatedAt);
      }

      for (const i of data.issues ?? []) {
        this.db.prepare(`
          INSERT OR REPLACE INTO issues (id, project_id, entity_id, file_path, type, title, description, severity, status, resolution, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(i.id, i.projectId, i.entityId ?? null, i.filePath ?? null, i.type, i.title,
               i.description ?? null, i.severity ?? 'medium', i.status ?? 'open',
               i.resolution ?? null,
               i.metadata ? JSON.stringify(i.metadata) : null, i.createdAt, i.updatedAt);
      }
    });

    doRestore();

    return {
      entities: data.entities?.length ?? 0,
      observations: data.observations?.length ?? 0,
      relations: data.relations?.length ?? 0,
      fileDigests: data.fileDigests?.length ?? 0,
      issues: data.issues?.length ?? 0,
      rules: data.rules?.length ?? 0,
      lessons: data.lessons?.length ?? 0,
    };
  }
}
