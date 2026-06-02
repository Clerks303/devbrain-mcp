import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Session, SessionEvent } from '../../types.js';
import { now, parseMetadata } from './helpers.js';

export function toSession(row: Record<string, unknown>): Session {
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

export function toSessionEvent(row: Record<string, unknown>): SessionEvent {
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

export class SessionRepository {
  constructor(private db: Database.Database) {}

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
}
