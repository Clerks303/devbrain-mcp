import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LearningPattern, RuleProposal, ContextFeedback, ContextScore, DeveloperProfile, PatternType } from './types.js';

function now(): string {
  return new Date().toISOString();
}

/** Data access layer for learning engine tables */
export class LearningStore {
  constructor(private readonly db: Database.Database) {}

  // --- Learning Patterns ---

  upsertPattern(params: {
    projectId: string;
    type: PatternType;
    signature: string;
    description: string;
    sessionId: string;
    metadata?: Record<string, unknown> | null;
  }): LearningPattern {
    const ts = now();
    const existing = this.db.prepare(
      'SELECT * FROM learning_patterns WHERE project_id = ? AND signature = ?'
    ).get(params.projectId, params.signature) as Record<string, unknown> | undefined;

    if (existing) {
      const evidence: string[] = JSON.parse(existing.evidence as string);
      if (!evidence.includes(params.sessionId)) {
        evidence.push(params.sessionId);
      }
      this.db.prepare(`
        UPDATE learning_patterns
        SET frequency = frequency + 1, last_seen_at = ?, evidence = ?,
            metadata = COALESCE(?, metadata)
        WHERE id = ?
      `).run(
        ts, JSON.stringify(evidence),
        params.metadata ? JSON.stringify(params.metadata) : null,
        existing.id as string,
      );
      return this.getPattern(existing.id as string)!;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO learning_patterns (id, project_id, type, signature, description, frequency, first_seen_at, last_seen_at, evidence, metadata)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, params.projectId, params.type, params.signature, params.description,
      ts, ts, JSON.stringify([params.sessionId]),
      params.metadata ? JSON.stringify(params.metadata) : null,
    );
    return this.getPattern(id)!;
  }

  getPattern(id: string): LearningPattern | null {
    const row = this.db.prepare('SELECT * FROM learning_patterns WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toLearningPattern(row) : null;
  }

  listPatterns(projectId: string, type?: PatternType, limit = 50): LearningPattern[] {
    let sql = 'SELECT * FROM learning_patterns WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    sql += ' ORDER BY frequency DESC LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toLearningPattern);
  }

  // --- Rule Proposals ---

  addProposal(params: {
    projectId: string;
    ruleId: string;
    currentSeverity: string;
    proposedSeverity: string;
    reason: string;
    observanceScore: number;
    sampleSize: number;
  }): RuleProposal {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO learning_rule_proposals (id, project_id, rule_id, current_severity, proposed_severity, reason, observance_score, sample_size, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id, params.projectId, params.ruleId, params.currentSeverity,
      params.proposedSeverity, params.reason, params.observanceScore,
      params.sampleSize, ts,
    );
    return this.getProposal(id)!;
  }

  getProposal(id: string): RuleProposal | null {
    const row = this.db.prepare('SELECT * FROM learning_rule_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRuleProposal(row) : null;
  }

  listProposals(projectId: string, status?: string, limit = 50): RuleProposal[] {
    let sql = 'SELECT * FROM learning_rule_proposals WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toRuleProposal);
  }

  resolveProposal(id: string, status: 'accepted' | 'rejected'): RuleProposal {
    this.db.prepare(
      'UPDATE learning_rule_proposals SET status = ?, resolved_at = ? WHERE id = ?'
    ).run(status, now(), id);
    return this.getProposal(id)!;
  }

  countPendingProposals(projectId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM learning_rule_proposals WHERE project_id = ? AND status = 'pending'"
    ).get(projectId) as { count: number };
    return row.count;
  }

  // --- Context Feedback ---

  addFeedback(params: {
    projectId: string;
    sessionId: string;
    contextId: string;
    contextType: string;
    wasUseful: boolean;
    score: number;
  }): ContextFeedback {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO context_feedback (id, project_id, session_id, context_id, context_type, was_useful, score, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.projectId, params.sessionId, params.contextId, params.contextType, params.wasUseful ? 1 : 0, params.score, now());
    return this.getFeedback(id)!;
  }

  getFeedback(id: string): ContextFeedback | null {
    const row = this.db.prepare('SELECT * FROM context_feedback WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toContextFeedback(row) : null;
  }

  listFeedbackForContext(projectId: string, contextId: string): ContextFeedback[] {
    return (this.db.prepare(
      'SELECT * FROM context_feedback WHERE project_id = ? AND context_id = ? ORDER BY recorded_at DESC'
    ).all(projectId, contextId) as Record<string, unknown>[]).map(toContextFeedback);
  }

  // --- Context Scores ---

  upsertContextScore(params: {
    projectId: string;
    contextId: string;
    contextType: string;
    usefulnessScore: number;
    feedbackCount: number;
  }): void {
    const ts = now();
    const existing = this.db.prepare(
      'SELECT id FROM context_scores WHERE project_id = ? AND context_id = ? AND context_type = ?'
    ).get(params.projectId, params.contextId, params.contextType) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE context_scores SET usefulness_score = ?, feedback_count = ?, last_updated_at = ? WHERE id = ?
      `).run(params.usefulnessScore, params.feedbackCount, ts, existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO context_scores (id, project_id, context_id, context_type, usefulness_score, feedback_count, last_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), params.projectId, params.contextId, params.contextType, params.usefulnessScore, params.feedbackCount, ts);
    }
  }

  getContextScore(projectId: string, contextId: string, contextType: string): ContextScore | null {
    const row = this.db.prepare(
      'SELECT * FROM context_scores WHERE project_id = ? AND context_id = ? AND context_type = ?'
    ).get(projectId, contextId, contextType) as Record<string, unknown> | undefined;
    return row ? toContextScore(row) : null;
  }

  // --- Developer Profile ---

  upsertProfile(projectId: string, profile: DeveloperProfile): void {
    const ts = now();
    this.db.prepare(`
      INSERT INTO developer_profiles (project_id, data, session_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, session_count = excluded.session_count, updated_at = excluded.updated_at
    `).run(projectId, JSON.stringify(profile), profile.sessionCount, ts);
  }

  getProfile(projectId: string): DeveloperProfile | null {
    const row = this.db.prepare('SELECT data FROM developer_profiles WHERE project_id = ?').get(projectId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as DeveloperProfile : null;
  }
}

// --- Row mappers ---

function toLearningPattern(row: Record<string, unknown>): LearningPattern {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as PatternType,
    signature: row.signature as string,
    description: row.description as string,
    frequency: row.frequency as number,
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    evidence: JSON.parse(row.evidence as string),
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  };
}

function toRuleProposal(row: Record<string, unknown>): RuleProposal {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    ruleId: row.rule_id as string,
    currentSeverity: row.current_severity as string,
    proposedSeverity: row.proposed_severity as string,
    reason: row.reason as string,
    observanceScore: row.observance_score as number,
    sampleSize: row.sample_size as number,
    status: row.status as RuleProposal['status'],
    createdAt: row.created_at as string,
    resolvedAt: row.resolved_at as string | null,
  };
}

function toContextFeedback(row: Record<string, unknown>): ContextFeedback {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    contextId: row.context_id as string,
    contextType: row.context_type as string,
    wasUseful: (row.was_useful as number) === 1,
    score: row.score as number,
    recordedAt: row.recorded_at as string,
  };
}

function toContextScore(row: Record<string, unknown>): ContextScore {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    contextId: row.context_id as string,
    contextType: row.context_type as string,
    usefulnessScore: row.usefulness_score as number,
    feedbackCount: row.feedback_count as number,
    lastUpdatedAt: row.last_updated_at as string,
  };
}
