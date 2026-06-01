import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { KnowledgeStore } from '../../src/db/store.js';
import {
  setProjectVision,
  getProjectVision,
  createGoal,
  getGoal,
  updateGoal,
  updateGoalStatus,
  deleteGoal,
  listGoals,
  linkGoalEntity,
  unlinkGoalEntity,
  getGoalEntities,
  getGoalEntityLinks,
  recordGoalMission,
  getGoalMissions,
  getGoalDelta,
  getEntityGoals,
} from '../../src/db/goals-store.js';
import { initDatabase } from '../../src/db/schema.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function createTestDb(): { db: Database.Database; store: KnowledgeStore; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-goals-test-'));
  const dbPath = path.join(tmp, 'test.db');
  const db = initDatabase(dbPath, 4);
  const store = new KnowledgeStore(db);
  return {
    db,
    store,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('goals-store — project_vision', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestDb();
    const project = ctx.store.addProject({ name: 'test', path: '/tmp/test' });
    projectId = project.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('returns null when no vision exists', () => {
    expect(getProjectVision(ctx.db, projectId)).toBeNull();
  });

  it('inserts a vision with all fields', () => {
    const vision = setProjectVision(ctx.db, projectId, {
      description: 'A platform for orchestrating AI agents',
      features: ['goals', 'missions'],
      stack: [{ layer: 'backend', tech: 'Rust' }, { layer: 'frontend', tech: 'Svelte' }],
      constraints: ['no network calls in worker'],
    });

    expect(vision.projectId).toBe(projectId);
    expect(vision.description).toContain('orchestrating');
    expect(vision.features).toEqual(['goals', 'missions']);
    expect(vision.stack).toHaveLength(2);
    expect(vision.constraints).toEqual(['no network calls in worker']);
  });

  it('upserts and preserves existing fields when partial', () => {
    setProjectVision(ctx.db, projectId, {
      description: 'v1',
      features: ['a', 'b'],
    });

    const v2 = setProjectVision(ctx.db, projectId, {
      description: 'v2',
    });

    expect(v2.description).toBe('v2');
    expect(v2.features).toEqual(['a', 'b']);
  });

  it('retrieves a stored vision', () => {
    setProjectVision(ctx.db, projectId, {
      description: 'hello',
      features: ['x'],
    });
    const got = getProjectVision(ctx.db, projectId);
    expect(got?.description).toBe('hello');
    expect(got?.features).toEqual(['x']);
  });
});

describe('goals-store — goals CRUD', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestDb();
    const project = ctx.store.addProject({ name: 'test', path: '/tmp/test' });
    projectId = project.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('creates a goal with defaults', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'Ship Phase 1' });
    expect(goal.id).toBeDefined();
    expect(goal.title).toBe('Ship Phase 1');
    expect(goal.priority).toBe('P1');
    expect(goal.status).toBe('not_started');
    expect(goal.parentGoalId).toBeNull();
  });

  it('creates a goal with custom priority and parent', () => {
    const parent = createGoal(ctx.db, projectId, { title: 'Parent' });
    const child = createGoal(ctx.db, projectId, {
      title: 'Child',
      priority: 'P0',
      parentGoalId: parent.id,
    });
    expect(child.priority).toBe('P0');
    expect(child.parentGoalId).toBe(parent.id);
  });

  it('updates a goal and returns a new instance', () => {
    const g = createGoal(ctx.db, projectId, { title: 'X' });
    const updated = updateGoal(ctx.db, g.id, { title: 'Y', priority: 'P0' });
    expect(updated.title).toBe('Y');
    expect(updated.priority).toBe('P0');
    // Ensure we get new object (no mutation of original)
    expect(g.title).toBe('X');
  });

  it('updateGoalStatus changes status', () => {
    const g = createGoal(ctx.db, projectId, { title: 'X' });
    const updated = updateGoalStatus(ctx.db, g.id, 'done');
    expect(updated.status).toBe('done');
  });

  it('throws when updating a non-existent goal', () => {
    expect(() => updateGoal(ctx.db, 'does-not-exist', { title: 'x' })).toThrow();
  });

  it('deletes a goal', () => {
    const g = createGoal(ctx.db, projectId, { title: 'X' });
    deleteGoal(ctx.db, g.id);
    expect(getGoal(ctx.db, g.id)).toBeNull();
  });

  it('lists goals filtered by status and priority', () => {
    createGoal(ctx.db, projectId, { title: 'A', priority: 'P0', status: 'done' });
    createGoal(ctx.db, projectId, { title: 'B', priority: 'P1', status: 'in_progress' });
    createGoal(ctx.db, projectId, { title: 'C', priority: 'P2', status: 'not_started' });

    const done = listGoals(ctx.db, projectId, { status: 'done' });
    expect(done).toHaveLength(1);

    const p0 = listGoals(ctx.db, projectId, { priority: 'P0' });
    expect(p0).toHaveLength(1);
    expect(p0[0].title).toBe('A');
  });

  it('lists goals ordered by priority (P0 first)', () => {
    createGoal(ctx.db, projectId, { title: 'third', priority: 'P2' });
    createGoal(ctx.db, projectId, { title: 'first', priority: 'P0' });
    createGoal(ctx.db, projectId, { title: 'second', priority: 'P1' });

    const goals = listGoals(ctx.db, projectId);
    expect(goals.map(g => g.priority)).toEqual(['P0', 'P1', 'P2']);
  });
});

describe('goals-store — goal ↔ entity links', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestDb();
    const project = ctx.store.addProject({ name: 'test', path: '/tmp/test' });
    projectId = project.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('links and retrieves entities for a goal', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'X' });
    const entity = ctx.store.addEntity({ name: 'UserService', type: 'class', projectId });

    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');
    const entities = getGoalEntities(ctx.db, goal.id);
    expect(entities).toHaveLength(1);
    expect(entities[0].id).toBe(entity.id);
    expect(entities[0].role).toBe('implements');
  });

  it('upserts link role when called twice', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'X' });
    const entity = ctx.store.addEntity({ name: 'X', type: 'class', projectId });

    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');
    linkGoalEntity(ctx.db, goal.id, entity.id, 'blocks');

    const links = getGoalEntityLinks(ctx.db, goal.id);
    expect(links).toHaveLength(1);
    expect(links[0].role).toBe('blocks');
  });

  it('unlinks an entity from a goal', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'X' });
    const entity = ctx.store.addEntity({ name: 'X', type: 'class', projectId });

    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');
    unlinkGoalEntity(ctx.db, goal.id, entity.id);

    expect(getGoalEntities(ctx.db, goal.id)).toHaveLength(0);
  });

  it('getEntityGoals returns all goals linked to an entity', () => {
    const e = ctx.store.addEntity({ name: 'Shared', type: 'module', projectId });
    const g1 = createGoal(ctx.db, projectId, { title: '1' });
    const g2 = createGoal(ctx.db, projectId, { title: '2' });

    linkGoalEntity(ctx.db, g1.id, e.id, 'implements');
    linkGoalEntity(ctx.db, g2.id, e.id, 'touches');

    const goals = getEntityGoals(ctx.db, e.id);
    expect(goals).toHaveLength(2);
  });

  it('cascades when goal is deleted', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'X' });
    const entity = ctx.store.addEntity({ name: 'X', type: 'class', projectId });
    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');

    deleteGoal(ctx.db, goal.id);
    expect(getGoalEntityLinks(ctx.db, goal.id)).toHaveLength(0);
  });
});

describe('goals-store — goal missions', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestDb();
    const project = ctx.store.addProject({ name: 'test', path: '/tmp/test' });
    projectId = project.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('records and retrieves a mission', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'X' });
    recordGoalMission(ctx.db, goal.id, 'mission-1', 'success');
    const missions = getGoalMissions(ctx.db, goal.id);
    expect(missions).toHaveLength(1);
    expect(missions[0].missionId).toBe('mission-1');
    expect(missions[0].outcome).toBe('success');
  });

  it('upserts mission outcome when called twice', () => {
    const goal = createGoal(ctx.db, projectId, { title: 'X' });
    recordGoalMission(ctx.db, goal.id, 'mission-1', 'partial');
    recordGoalMission(ctx.db, goal.id, 'mission-1', 'success');

    const missions = getGoalMissions(ctx.db, goal.id);
    expect(missions).toHaveLength(1);
    expect(missions[0].outcome).toBe('success');
  });
});

describe('goals-store — getGoalDelta', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  beforeEach(() => {
    ctx = createTestDb();
    const project = ctx.store.addProject({ name: 'test', path: '/tmp/test' });
    projectId = project.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('returns zero counts for empty project', () => {
    const delta = getGoalDelta(ctx.db, projectId);
    expect(delta.total).toBe(0);
    expect(delta.coverage_percent).toBe(0);
    expect(delta.goals).toEqual([]);
  });

  it('computes totals across 5 goals with mixed state', () => {
    createGoal(ctx.db, projectId, { title: 'a', priority: 'P0', status: 'done' });
    createGoal(ctx.db, projectId, { title: 'b', priority: 'P0', status: 'done' });
    createGoal(ctx.db, projectId, { title: 'c', priority: 'P1', status: 'in_progress' });
    createGoal(ctx.db, projectId, { title: 'd', priority: 'P1', status: 'in_progress' });
    createGoal(ctx.db, projectId, { title: 'e', priority: 'P2', status: 'blocked' });

    const delta = getGoalDelta(ctx.db, projectId);
    expect(delta.total).toBe(5);
    expect(delta.done).toBe(2);
    expect(delta.in_progress).toBe(2);
    expect(delta.blocked).toBe(1);
    expect(delta.not_started).toBe(0);
    expect(delta.coverage_percent).toBe(40); // 2/5 = 40%

    expect(delta.by_priority.P0.total).toBe(2);
    expect(delta.by_priority.P0.done).toBe(2);
    expect(delta.by_priority.P1.total).toBe(2);
    expect(delta.by_priority.P1.in_progress).toBe(2);
    expect(delta.by_priority.P2.blocked).toBe(1);

    expect(delta.goals).toHaveLength(5);
  });

  it('orders goals by priority then status (in_progress first)', () => {
    createGoal(ctx.db, projectId, { title: 'p2-done', priority: 'P2', status: 'done' });
    createGoal(ctx.db, projectId, { title: 'p0-in-progress', priority: 'P0', status: 'in_progress' });
    createGoal(ctx.db, projectId, { title: 'p0-done', priority: 'P0', status: 'done' });

    const delta = getGoalDelta(ctx.db, projectId);
    // P0 first, in_progress before done within P0
    expect(delta.goals[0].title).toBe('p0-in-progress');
    expect(delta.goals[1].title).toBe('p0-done');
  });

  it('includes entities_count and missions_count per goal', () => {
    const g = createGoal(ctx.db, projectId, { title: 'X' });
    const e = ctx.store.addEntity({ name: 'E', type: 'class', projectId });
    linkGoalEntity(ctx.db, g.id, e.id, 'implements');
    recordGoalMission(ctx.db, g.id, 'm1', 'success');

    const delta = getGoalDelta(ctx.db, projectId);
    expect(delta.goals[0].entities_count).toBe(1);
    expect(delta.goals[0].missions_count).toBe(1);
  });
});

describe('goals-store — schema migration idempotence', () => {
  it('can call initDatabase twice without error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-migrate-'));
    const dbPath = path.join(tmp, 'm.db');

    const db1 = initDatabase(dbPath, 4);
    const store = new KnowledgeStore(db1);
    const project = store.addProject({ name: 'test', path: '/tmp/test' });
    const g = createGoal(db1, project.id, { title: 'X' });
    db1.close();

    // Second open should not throw and should preserve data
    const db2 = initDatabase(dbPath, 4);
    const got = getGoal(db2, g.id);
    expect(got?.title).toBe('X');
    db2.close();

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
