import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Rule } from '../../types.js';
import { now, parseMetadata } from './helpers.js';

export function toRule(row: Record<string, unknown>): Rule {
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

function simpleGlobMatch(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(text);
}

export class RuleRepository {
  constructor(private db: Database.Database) {}

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
}
