import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Entity, Relation, Observation, Project, GraphSummary, FileDigest, StalenessResult, Issue, Session, SessionEvent, Rule, Lesson, Snapshot } from '../types.js';
import { encodeCursor, decodeCursor, type Page } from './pagination.js';
import { SnapshotPayloadSchema, SnapshotCorruptedError } from './snapshot-schema.js';

function now(): string {
  return new Date().toISOString();
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function toEntity(row: Record<string, unknown>): Entity {
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

function toRelation(row: Record<string, unknown>): Relation {
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

function toObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    content: row.content as string,
    source: (row.source as string) ?? null,
    category: (row.category as string) ?? 'note',
    createdAt: row.created_at as string,
  };
}

function toProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    path: (row.path as string) ?? null,
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
  };
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function toFileDigest(row: Record<string, unknown>): FileDigest {
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

function toIssue(row: Record<string, unknown>): Issue {
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

function toSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    goal: row.goal as string,
    summary: (row.summary as string) ?? null,
    toolCalls: (row.tool_calls as number) ?? 0,
    entitiesModified: (row.entities_modified as number) ?? 0,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
  };
}

function toSessionEvent(row: Record<string, unknown>): SessionEvent {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    type: row.type as SessionEvent['type'],
    content: row.content as string,
    toolName: (row.tool_name as string) ?? null,
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
  };
}

function toRule(row: Record<string, unknown>): Rule {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    scope: row.scope as Rule['scope'],
    pattern: (row.pattern as string) ?? null,
    content: row.content as string,
    severity: (row.severity as Rule['severity']) ?? 'should',
    metadata: parseMetadata(row.metadata as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toLesson(row: Record<string, unknown>): Lesson {
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

function toSnapshot(row: Record<string, unknown>): Snapshot {
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

function simpleGlobMatch(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(text);
}

export class KnowledgeStore {
  constructor(private db: Database.Database) {}

  // --- Entities ---

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
  // paths. Each method does a single round-trip; callers are expected to
  // chunk inputs above ~900 ids to stay under SQLite's variable limit.

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
    // Escape FTS5 special characters and use prefix search
    const ftsQuery = name.replace(/['"*():^~{}/\\]/g, '');
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

  // --- Relations ---

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

  // --- Observations ---

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

  // --- Projects ---

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

  // --- Summary ---

  getGraphSummary(projectId?: string | null): GraphSummary {
    const entityFilter = projectId
      ? 'WHERE project_id = ? OR project_id IS NULL'
      : '';
    const entityParams = projectId ? [projectId] : [];

    const entityCount = (this.db.prepare(
      `SELECT COUNT(*) as c FROM entities ${entityFilter}`
    ).get(...entityParams) as { c: number }).c;

    const relationCount = (this.db.prepare(`
      SELECT COUNT(*) as c FROM relations
      ${projectId ? 'WHERE from_entity_id IN (SELECT id FROM entities WHERE project_id = ? OR project_id IS NULL)' : ''}
    `).get(...entityParams) as { c: number }).c;

    const observationCount = (this.db.prepare(`
      SELECT COUNT(*) as c FROM observations
      ${projectId ? 'WHERE entity_id IN (SELECT id FROM entities WHERE project_id = ? OR project_id IS NULL)' : ''}
    `).get(...entityParams) as { c: number }).c;

    const topEntities = (this.db.prepare(`
      SELECT e.name, e.type, COUNT(r.id) as relation_count
      FROM entities e
      LEFT JOIN relations r ON r.from_entity_id = e.id OR r.to_entity_id = e.id
      ${projectId ? 'WHERE (e.project_id = ? OR e.project_id IS NULL)' : ''}
      GROUP BY e.id
      ORDER BY relation_count DESC
      LIMIT 10
    `).all(...entityParams) as { name: string; type: string; relation_count: number }[])
      .map(r => ({ name: r.name, type: r.type, relationCount: r.relation_count }));

    const typeRows = this.db.prepare(`
      SELECT type, COUNT(*) as c FROM entities
      ${entityFilter}
      GROUP BY type
    `).all(...entityParams) as { type: string; c: number }[];

    const entityTypes: Record<string, number> = {};
    for (const row of typeRows) {
      entityTypes[row.type] = row.c;
    }

    const fileDigestCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM file_digests ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const issueCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM issues ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const openIssueCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM issues WHERE status = 'open' ${projectId ? 'AND project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const sessionCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM sessions ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const ruleCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM rules ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const lessonCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM lessons ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    return { entityCount, relationCount, observationCount, fileDigestCount, issueCount, openIssueCount, sessionCount, ruleCount, lessonCount, topEntities, entityTypes };
  }

  // --- File Digests ---

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

  // --- Issues ---

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

  deleteIssue(id: string): void {
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  }

  // --- Database accessor ---

  getDb(): Database.Database {
    return this.db;
  }

  // --- Sessions ---

  startSession(params: { projectId: string; goal: string }): Session {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO sessions (id, project_id, goal, tool_calls, entities_modified, started_at)
      VALUES (?, ?, ?, 0, 0, ?)
    `).run(id, params.projectId, params.goal, ts);
    return this.getSession(id)!;
  }

  endSession(id: string, summary?: string): Session {
    const ts = now();
    if (summary !== undefined) {
      this.db.prepare('UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?').run(ts, summary, id);
    } else {
      this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(ts, id);
    }
    return this.getSession(id)!;
  }

  updateSessionCounters(id: string, increments: { toolCalls?: number; entitiesModified?: number }): void {
    if (increments.toolCalls) {
      this.db.prepare('UPDATE sessions SET tool_calls = tool_calls + ? WHERE id = ?').run(increments.toolCalls, id);
    }
    if (increments.entitiesModified) {
      this.db.prepare('UPDATE sessions SET entities_modified = entities_modified + ? WHERE id = ?').run(increments.entitiesModified, id);
    }
  }

  addSessionEvent(params: {
    sessionId: string;
    type: SessionEvent['type'];
    content: string;
    toolName?: string | null;
    metadata?: Record<string, unknown> | null;
  }): SessionEvent {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO session_events (id, session_id, type, content, tool_name, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.sessionId, params.type, params.content,
      params.toolName ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      ts,
    );
    return this.getSessionEvent(id)!;
  }

  getSessionEvent(id: string): SessionEvent | null {
    const row = this.db.prepare('SELECT * FROM session_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toSessionEvent(row) : null;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toSession(row) : null;
  }

  listSessions(projectId: string, limit: number = 100, offset: number = 0): Session[] {
    const sql = 'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?';
    return (this.db.prepare(sql).all(projectId, limit, offset) as Record<string, unknown>[]).map(toSession);
  }

  getSessionEvents(sessionId: string): SessionEvent[] {
    return (this.db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as Record<string, unknown>[]).map(toSessionEvent);
  }

  getLastSession(projectId: string): Session | null {
    const row = this.db.prepare(
      'SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1'
    ).get(projectId) as Record<string, unknown> | undefined;
    return row ? toSession(row) : null;
  }

  // --- Rules ---

  addRule(params: {
    projectId: string;
    scope?: Rule['scope'];
    pattern?: string | null;
    content: string;
    severity?: Rule['severity'];
    metadata?: Record<string, unknown> | null;
  }): Rule {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO rules (id, project_id, scope, pattern, content, severity, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.projectId, params.scope ?? 'global', params.pattern ?? null,
      params.content, params.severity ?? 'should',
      params.metadata ? JSON.stringify(params.metadata) : null,
      ts, ts,
    );
    return this.getRule(id)!;
  }

  getRule(id: string): Rule | null {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRule(row) : null;
  }

  updateRule(id: string, updates: {
    content?: string;
    severity?: Rule['severity'];
    scope?: Rule['scope'];
    pattern?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Rule {
    const existing = this.getRule(id);
    if (!existing) throw new Error(`Rule not found: ${id}`);

    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now()];

    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.severity !== undefined) { sets.push('severity = ?'); values.push(updates.severity); }
    if (updates.scope !== undefined) { sets.push('scope = ?'); values.push(updates.scope); }
    if (updates.pattern !== undefined) { sets.push('pattern = ?'); values.push(updates.pattern); }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    values.push(id);
    this.db.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getRule(id)!;
  }

  listRules(projectId: string, scope?: Rule['scope'], limit: number = 100, offset: number = 0): Rule[] {
    let sql = 'SELECT * FROM rules WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (scope) { sql += ' AND scope = ?'; params.push(scope); }
    sql += ' ORDER BY severity ASC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toRule);
  }

  matchRules(projectId: string, context: { filePath?: string; entityType?: string }): Rule[] {
    const allRules = this.listRules(projectId);
    return allRules.filter(rule => {
      if (rule.scope === 'global') return true;
      if (rule.scope === 'file_pattern' && context.filePath && rule.pattern) {
        return simpleGlobMatch(rule.pattern, context.filePath);
      }
      if (rule.scope === 'entity_type' && context.entityType && rule.pattern) {
        return rule.pattern === context.entityType;
      }
      return false;
    });
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  }

  // --- Lessons ---

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

  // --- Snapshots ---

  createSnapshot(projectId: string, label: string, description?: string | null): Snapshot {
    const id = randomUUID();
    const ts = now();

    // Snapshot the entire project — fetch without the listEntities default
    // limit (100), which would silently truncate large projects. Two N+1
    // loops over entities (relations + observations) collapsed into single
    // project-scoped queries.
    const entities = (this.db.prepare(
      `SELECT * FROM entities WHERE (project_id = ? OR project_id IS NULL) ORDER BY updated_at DESC`,
    ).all(projectId) as Record<string, unknown>[]).map(toEntity);

    const relations = (this.db.prepare(
      `SELECT * FROM relations WHERE from_entity_id IN (
         SELECT id FROM entities WHERE project_id = ? OR project_id IS NULL
       )`,
    ).all(projectId) as Record<string, unknown>[]).map(toRelation);

    const observations = (this.db.prepare(
      `SELECT * FROM observations WHERE entity_id IN (
         SELECT id FROM entities WHERE project_id = ? OR project_id IS NULL
       )`,
    ).all(projectId) as Record<string, unknown>[]).map(toObservation);

    // These tables are always created by initDatabase(); a failure here is a real error
    // (lock contention, schema drift, corruption). Swallowing it would silently produce
    // an incomplete snapshot that, when later restored, would wipe live data with [].
    // Override the default limit (100) with an effectively-unbounded one — a snapshot
    // that silently drops the 101st rule on restore is a data-loss bug.
    const SNAPSHOT_LIMIT = 1_000_000;
    const fileDigests = this.listFileDigests(projectId, { limit: SNAPSHOT_LIMIT });
    const issues = this.listIssues(projectId, { limit: SNAPSHOT_LIMIT });
    const rules = this.listRules(projectId, undefined, SNAPSHOT_LIMIT);
    const lessons = this.listLessons(projectId, { limit: SNAPSHOT_LIMIT });

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

  // --- Cursor-based pagination ---
  //
  // These return Page<T> with an opaque nextCursor. Use them on lists that
  // can grow beyond ~10k rows (entities, issues). Existing offset/limit
  // methods remain for back-compat and small lists.

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
