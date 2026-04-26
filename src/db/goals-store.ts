/**
 * Repository for project vision and goals (Destination Layer).
 * Pure CRUD — all functions take an explicit Database instance and return
 * new objects (no mutation of inputs).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  Entity,
  Goal,
  GoalEntityLink,
  GoalEntityRole,
  GoalMission,
  GoalMissionOutcome,
  GoalPriority,
  GoalStatus,
  ProjectVision,
  VisionStackItem,
} from '../types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toVision(row: Record<string, unknown>): ProjectVision {
  return {
    projectId: row.project_id as string,
    description: (row.description as string) ?? null,
    features: parseJsonArray<string>(row.features_json as string | null),
    stack: parseJsonArray<VisionStackItem>(row.stack_json as string | null),
    constraints: parseJsonArray<string>(row.constraints_json as string | null),
    updatedAt: (row.updated_at as string) ?? nowIso(),
  };
}

function toGoal(row: Record<string, unknown>): Goal {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: (row.description as string) ?? null,
    priority: (row.priority as GoalPriority) ?? 'P1',
    status: (row.status as GoalStatus) ?? 'not_started',
    parentGoalId: (row.parent_goal_id as string) ?? null,
    createdAt: (row.created_at as string) ?? nowIso(),
    updatedAt: (row.updated_at as string) ?? nowIso(),
  };
}

function toEntityRow(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    projectId: (row.project_id as string) ?? null,
    content: (row.content as string) ?? null,
    metadata: null,
    status: (row.status as string) ?? 'unknown',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// --- Vision ---

export interface VisionInput {
  description?: string | null;
  features?: string[];
  stack?: VisionStackItem[];
  constraints?: string[];
}

export function setProjectVision(
  db: Database.Database,
  projectId: string,
  input: VisionInput,
): ProjectVision {
  const existing = getProjectVision(db, projectId);
  const ts = nowIso();

  const next: ProjectVision = {
    projectId,
    description: input.description ?? existing?.description ?? null,
    features: input.features ?? existing?.features ?? [],
    stack: input.stack ?? existing?.stack ?? [],
    constraints: input.constraints ?? existing?.constraints ?? [],
    updatedAt: ts,
  };

  db.prepare(`
    INSERT INTO project_vision (project_id, description, features_json, stack_json, constraints_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      description = excluded.description,
      features_json = excluded.features_json,
      stack_json = excluded.stack_json,
      constraints_json = excluded.constraints_json,
      updated_at = excluded.updated_at
  `).run(
    projectId,
    next.description,
    JSON.stringify(next.features),
    JSON.stringify(next.stack),
    JSON.stringify(next.constraints),
    ts,
  );

  return next;
}

export function getProjectVision(
  db: Database.Database,
  projectId: string,
): ProjectVision | null {
  const row = db.prepare('SELECT * FROM project_vision WHERE project_id = ?')
    .get(projectId) as Record<string, unknown> | undefined;
  return row ? toVision(row) : null;
}

// --- Goals ---

export interface CreateGoalInput {
  title: string;
  description?: string | null;
  priority?: GoalPriority;
  status?: GoalStatus;
  parentGoalId?: string | null;
}

export function createGoal(
  db: Database.Database,
  projectId: string,
  input: CreateGoalInput,
): Goal {
  const id = randomUUID();
  const ts = nowIso();
  db.prepare(`
    INSERT INTO project_goals (id, project_id, title, description, priority, status, parent_goal_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    input.title,
    input.description ?? null,
    input.priority ?? 'P1',
    input.status ?? 'not_started',
    input.parentGoalId ?? null,
    ts,
    ts,
  );
  const goal = getGoal(db, id);
  if (!goal) throw new Error(`Failed to create goal: ${id}`);
  return goal;
}

export function getGoal(db: Database.Database, goalId: string): Goal | null {
  const row = db.prepare('SELECT * FROM project_goals WHERE id = ?')
    .get(goalId) as Record<string, unknown> | undefined;
  return row ? toGoal(row) : null;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  priority?: GoalPriority;
  status?: GoalStatus;
  parentGoalId?: string | null;
}

export function updateGoal(
  db: Database.Database,
  goalId: string,
  updates: UpdateGoalInput,
): Goal {
  const existing = getGoal(db, goalId);
  if (!existing) throw new Error(`Goal not found: ${goalId}`);

  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [nowIso()];

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); values.push(updates.priority); }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.parentGoalId !== undefined) { sets.push('parent_goal_id = ?'); values.push(updates.parentGoalId); }

  values.push(goalId);
  db.prepare(`UPDATE project_goals SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getGoal(db, goalId)!;
}

export function updateGoalStatus(
  db: Database.Database,
  goalId: string,
  status: GoalStatus,
): Goal {
  return updateGoal(db, goalId, { status });
}

export function deleteGoal(db: Database.Database, goalId: string): void {
  db.prepare('DELETE FROM project_goals WHERE id = ?').run(goalId);
}

export interface ListGoalsFilters {
  status?: GoalStatus;
  priority?: GoalPriority;
  parentGoalId?: string | null;
  limit?: number;
  offset?: number;
}

export function listGoals(
  db: Database.Database,
  projectId: string,
  filters?: ListGoalsFilters,
): Goal[] {
  let sql = 'SELECT * FROM project_goals WHERE project_id = ?';
  const params: unknown[] = [projectId];

  if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters?.priority) { sql += ' AND priority = ?'; params.push(filters.priority); }
  if (filters?.parentGoalId !== undefined) {
    if (filters.parentGoalId === null) {
      sql += ' AND parent_goal_id IS NULL';
    } else {
      sql += ' AND parent_goal_id = ?';
      params.push(filters.parentGoalId);
    }
  }

  // Priority order: P0 < P1 < P2 < P3 (natural string order works)
  sql += ' ORDER BY priority ASC, created_at ASC LIMIT ? OFFSET ?';
  params.push(filters?.limit ?? 200, filters?.offset ?? 0);

  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toGoal);
}

// --- Goal ↔ Entity Links ---

export function linkGoalEntity(
  db: Database.Database,
  goalId: string,
  entityId: string,
  role: GoalEntityRole = 'implements',
): void {
  db.prepare(`
    INSERT INTO goal_entities (goal_id, entity_id, role)
    VALUES (?, ?, ?)
    ON CONFLICT(goal_id, entity_id) DO UPDATE SET role = excluded.role
  `).run(goalId, entityId, role);
}

export function unlinkGoalEntity(
  db: Database.Database,
  goalId: string,
  entityId: string,
): void {
  db.prepare('DELETE FROM goal_entities WHERE goal_id = ? AND entity_id = ?')
    .run(goalId, entityId);
}

export function getGoalEntities(
  db: Database.Database,
  goalId: string,
): Array<Entity & { role: GoalEntityRole }> {
  const rows = db.prepare(`
    SELECT e.*, ge.role as role
    FROM goal_entities ge
    INNER JOIN entities e ON e.id = ge.entity_id
    WHERE ge.goal_id = ?
    ORDER BY e.name ASC
  `).all(goalId) as Record<string, unknown>[];

  return rows.map(row => ({
    ...toEntityRow(row),
    role: (row.role as GoalEntityRole) ?? 'implements',
  }));
}

export function getEntityGoals(
  db: Database.Database,
  entityId: string,
): Array<Goal & { role: GoalEntityRole }> {
  const rows = db.prepare(`
    SELECT g.*, ge.role as role
    FROM goal_entities ge
    INNER JOIN project_goals g ON g.id = ge.goal_id
    WHERE ge.entity_id = ?
  `).all(entityId) as Record<string, unknown>[];

  return rows.map(row => ({
    ...toGoal(row),
    role: (row.role as GoalEntityRole) ?? 'implements',
  }));
}

export function getGoalEntityLinks(
  db: Database.Database,
  goalId: string,
): GoalEntityLink[] {
  const rows = db.prepare('SELECT goal_id, entity_id, role FROM goal_entities WHERE goal_id = ?')
    .all(goalId) as Record<string, unknown>[];
  return rows.map(r => ({
    goalId: r.goal_id as string,
    entityId: r.entity_id as string,
    role: (r.role as GoalEntityRole) ?? 'implements',
  }));
}

// --- Goal ↔ Mission Log ---

export function recordGoalMission(
  db: Database.Database,
  goalId: string,
  missionId: string,
  outcome?: GoalMissionOutcome | null,
): void {
  db.prepare(`
    INSERT INTO goal_missions (goal_id, mission_id, outcome)
    VALUES (?, ?, ?)
    ON CONFLICT(goal_id, mission_id) DO UPDATE SET outcome = excluded.outcome
  `).run(goalId, missionId, outcome ?? null);
}

export function getGoalMissions(
  db: Database.Database,
  goalId: string,
): GoalMission[] {
  const rows = db.prepare(
    'SELECT goal_id, mission_id, outcome, created_at FROM goal_missions WHERE goal_id = ? ORDER BY created_at DESC'
  ).all(goalId) as Record<string, unknown>[];

  return rows.map(r => ({
    goalId: r.goal_id as string,
    missionId: r.mission_id as string,
    outcome: (r.outcome as GoalMissionOutcome) ?? null,
    createdAt: (r.created_at as string) ?? nowIso(),
  }));
}

// --- Aggregates (Delta) ---

export interface GoalDeltaByPriority {
  P0: GoalCountBucket;
  P1: GoalCountBucket;
  P2: GoalCountBucket;
  P3: GoalCountBucket;
}

export interface GoalCountBucket {
  total: number;
  done: number;
  in_progress: number;
  not_started: number;
  blocked: number;
}

export interface GoalDeltaRow {
  id: string;
  title: string;
  priority: GoalPriority;
  status: GoalStatus;
  entities_count: number;
  missions_count: number;
}

export interface GoalDelta {
  total: number;
  done: number;
  in_progress: number;
  not_started: number;
  blocked: number;
  coverage_percent: number;
  by_priority: GoalDeltaByPriority;
  goals: GoalDeltaRow[];
}

function emptyBucket(): GoalCountBucket {
  return { total: 0, done: 0, in_progress: 0, not_started: 0, blocked: 0 };
}

export function getGoalDelta(
  db: Database.Database,
  projectId: string,
): GoalDelta {
  const statusRows = db.prepare(`
    SELECT priority, status, COUNT(*) as c
    FROM project_goals
    WHERE project_id = ?
    GROUP BY priority, status
  `).all(projectId) as { priority: string; status: string; c: number }[];

  const byPriority: GoalDeltaByPriority = {
    P0: emptyBucket(),
    P1: emptyBucket(),
    P2: emptyBucket(),
    P3: emptyBucket(),
  };

  let total = 0;
  let done = 0;
  let inProgress = 0;
  let notStarted = 0;
  let blocked = 0;

  for (const row of statusRows) {
    const priority = row.priority as GoalPriority;
    const status = row.status as GoalStatus;
    const bucket = byPriority[priority] ?? emptyBucket();
    bucket.total += row.c;
    if (status === 'done') { bucket.done += row.c; done += row.c; }
    else if (status === 'in_progress') { bucket.in_progress += row.c; inProgress += row.c; }
    else if (status === 'not_started') { bucket.not_started += row.c; notStarted += row.c; }
    else if (status === 'blocked') { bucket.blocked += row.c; blocked += row.c; }
    byPriority[priority] = bucket;
    total += row.c;
  }

  const coverage = total > 0 ? Math.round((done / total) * 10000) / 100 : 0;

  const goalRows = db.prepare(`
    SELECT
      g.id, g.title, g.priority, g.status,
      (SELECT COUNT(*) FROM goal_entities ge WHERE ge.goal_id = g.id) as entities_count,
      (SELECT COUNT(*) FROM goal_missions gm WHERE gm.goal_id = g.id) as missions_count
    FROM project_goals g
    WHERE g.project_id = ?
    ORDER BY g.priority ASC,
      CASE g.status
        WHEN 'in_progress' THEN 0
        WHEN 'not_started' THEN 1
        WHEN 'blocked' THEN 2
        WHEN 'done' THEN 3
        ELSE 4
      END ASC,
      g.created_at ASC
  `).all(projectId) as Record<string, unknown>[];

  const goals: GoalDeltaRow[] = goalRows.map(r => ({
    id: r.id as string,
    title: r.title as string,
    priority: r.priority as GoalPriority,
    status: r.status as GoalStatus,
    entities_count: (r.entities_count as number) ?? 0,
    missions_count: (r.missions_count as number) ?? 0,
  }));

  return {
    total,
    done,
    in_progress: inProgress,
    not_started: notStarted,
    blocked,
    coverage_percent: coverage,
    by_priority: byPriority,
    goals,
  };
}
