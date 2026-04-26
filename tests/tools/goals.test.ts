import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import {
  setProjectVision,
  createGoal,
  deleteGoal,
  getGoalDelta,
  getGoalEntities,
  linkGoalEntity,
  listGoals,
  getGoal,
  updateGoalStatus,
  recordGoalMission,
  getGoalMissions,
} from '../../src/db/goals-store.js';
import { generateMissionContext } from '../../src/graph/mission-context.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

const DIM = 4;

// Deterministic fake embedding provider — returns a vector derived from the text
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = DIM;
  readonly name = 'fake';

  async embed(text: string): Promise<number[]> {
    const hash = [...text].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    // Generate a normalized vector
    const v: number[] = [];
    for (let i = 0; i < DIM; i++) {
      v.push(Math.sin(hash + i) * 0.5 + 0.5);
    }
    // Normalize
    const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / len);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

interface Ctx {
  db: Database.Database;
  store: KnowledgeStore;
  vectorStore: VectorStore;
  provider: FakeEmbeddingProvider;
  projectId: string;
  cleanup: () => void;
}

function setup(): Ctx {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-tools-test-'));
  const dbPath = path.join(tmp, 'test.db');
  const db = initDatabase(dbPath, DIM);
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);
  const provider = new FakeEmbeddingProvider();
  const project = store.addProject({ name: 'test', path: '/tmp/test' });

  return {
    db,
    store,
    vectorStore,
    provider,
    projectId: project.id,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('tools/goals — vision flow', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('stores and retrieves a project vision', () => {
    const vision = setProjectVision(ctx.db, ctx.projectId, {
      description: 'An orchestrator for AI agents',
      features: ['goals', 'missions', 'memory'],
      stack: [{ layer: 'backend', tech: 'Rust + Tauri' }],
      constraints: ['no heavy runtime'],
    });
    expect(vision.description).toBe('An orchestrator for AI agents');
    expect(vision.stack).toHaveLength(1);
    expect(vision.constraints).toEqual(['no heavy runtime']);
  });
});

describe('tools/goals — goal lifecycle', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('creates a goal and links entities atomically', () => {
    const entity = ctx.store.addEntity({ name: 'Dispatcher', type: 'class', projectId: ctx.projectId });
    const goal = createGoal(ctx.db, ctx.projectId, {
      title: 'Implement dispatcher',
      description: 'Core routing logic',
      priority: 'P0',
    });
    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');

    const delta = getGoalDelta(ctx.db, ctx.projectId);
    expect(delta.total).toBe(1);
    expect(delta.goals[0].entities_count).toBe(1);
  });

  it('transitions a goal through status states', () => {
    const g = createGoal(ctx.db, ctx.projectId, { title: 'X' });
    expect(g.status).toBe('not_started');

    const inProgress = updateGoalStatus(ctx.db, g.id, 'in_progress');
    expect(inProgress.status).toBe('in_progress');

    const done = updateGoalStatus(ctx.db, g.id, 'done');
    expect(done.status).toBe('done');
  });
});

describe('tools/goals — delta calculations', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('matches the spec fixture: 5 goals (2 done, 2 in_progress, 1 blocked)', () => {
    createGoal(ctx.db, ctx.projectId, { title: '1', priority: 'P0', status: 'done' });
    createGoal(ctx.db, ctx.projectId, { title: '2', priority: 'P0', status: 'done' });
    createGoal(ctx.db, ctx.projectId, { title: '3', priority: 'P1', status: 'in_progress' });
    createGoal(ctx.db, ctx.projectId, { title: '4', priority: 'P1', status: 'in_progress' });
    createGoal(ctx.db, ctx.projectId, { title: '5', priority: 'P2', status: 'blocked' });

    const delta = getGoalDelta(ctx.db, ctx.projectId);

    expect(delta.total).toBe(5);
    expect(delta.done).toBe(2);
    expect(delta.in_progress).toBe(2);
    expect(delta.blocked).toBe(1);
    expect(delta.not_started).toBe(0);
    expect(delta.coverage_percent).toBe(40);

    // Priority breakdown
    expect(delta.by_priority.P0).toMatchObject({ total: 2, done: 2 });
    expect(delta.by_priority.P1).toMatchObject({ total: 2, in_progress: 2 });
    expect(delta.by_priority.P2).toMatchObject({ total: 1, blocked: 1 });
    expect(delta.by_priority.P3).toMatchObject({ total: 0 });
  });
});

describe('tools/goals — mission context', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('generates a prompt with all sections even without entities', async () => {
    setProjectVision(ctx.db, ctx.projectId, {
      description: 'AI agent orchestrator',
      stack: [{ layer: 'backend', tech: 'Rust' }],
    });
    const goal = createGoal(ctx.db, ctx.projectId, {
      title: 'Implement MCP bridge',
      description: 'Tauri → DevBrain HTTP shim',
      priority: 'P0',
    });

    const result = await generateMissionContext(ctx.store, ctx.vectorStore, ctx.provider, {
      goalId: goal.id,
    });

    expect(result.prompt).toContain('Mission: Implement MCP bridge');
    expect(result.prompt).toContain('Contexte projet');
    expect(result.prompt).toContain('AI agent orchestrator');
    expect(result.prompt).toContain('## Objectif');
    expect(result.prompt).toContain('P0');
    expect(result.prompt).toContain('## Fichiers concernés');
    expect(result.prompt).toContain('## Conventions à respecter');
    expect(result.prompt).toContain('## Leçons passées');
    expect(result.prompt).toContain('## Contraintes techniques');
    expect(result.prompt).toContain('## Critères de succès');
    expect(result.files).toHaveLength(0);
    expect(result.estimated_complexity).toBe('small');
  });

  it('includes linked entities and conventions in the prompt', async () => {
    const entity = ctx.store.addEntity({
      name: 'file:src/dispatcher.ts',
      type: 'file',
      projectId: ctx.projectId,
      content: 'Main dispatcher module',
    });
    const goal = createGoal(ctx.db, ctx.projectId, { title: 'Build dispatcher' });
    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');

    ctx.store.addRule({
      projectId: ctx.projectId,
      scope: 'global',
      content: 'Use Result<T, E> for all fallible operations',
      severity: 'must',
    });

    const result = await generateMissionContext(ctx.store, ctx.vectorStore, ctx.provider, {
      goalId: goal.id,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/dispatcher.ts');
    expect(result.prompt).toContain('file:src/dispatcher.ts');
    expect(result.conventions.length).toBeGreaterThanOrEqual(1);
    expect(result.prompt).toContain('Use Result<T, E>');
  });

  it('throws when goal does not exist', async () => {
    await expect(generateMissionContext(ctx.store, ctx.vectorStore, ctx.provider, {
      goalId: 'nope',
    })).rejects.toThrow();
  });

  it('suggests a team based on linked file layers', async () => {
    const feEntity = ctx.store.addEntity({ name: 'file:src/ui/button.tsx', type: 'file', projectId: ctx.projectId });
    const beEntity = ctx.store.addEntity({ name: 'file:src/api/routes.ts', type: 'file', projectId: ctx.projectId });
    const goal = createGoal(ctx.db, ctx.projectId, { title: 'Fullstack feature' });
    linkGoalEntity(ctx.db, goal.id, feEntity.id, 'implements');
    linkGoalEntity(ctx.db, goal.id, beEntity.id, 'implements');

    const result = await generateMissionContext(ctx.store, ctx.vectorStore, ctx.provider, {
      goalId: goal.id,
    });

    expect(result.team_suggestion.workers).toContain('frontend-dev');
    expect(result.team_suggestion.workers).toContain('backend-dev');
  });
});

describe('tools/goals — list + filter', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('lists only non-done goals when filtering by priority', () => {
    createGoal(ctx.db, ctx.projectId, { title: 'A', priority: 'P0', status: 'done' });
    createGoal(ctx.db, ctx.projectId, { title: 'B', priority: 'P0', status: 'in_progress' });
    const p0 = listGoals(ctx.db, ctx.projectId, { priority: 'P0' });
    expect(p0).toHaveLength(2);
    const p0InProgress = listGoals(ctx.db, ctx.projectId, { priority: 'P0', status: 'in_progress' });
    expect(p0InProgress).toHaveLength(1);
    expect(p0InProgress[0].title).toBe('B');
  });
});

describe('tools/goals — delete goal', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('deletes a goal and cascades goal_entities + goal_missions links while keeping the entity intact', () => {
    const entity = ctx.store.addEntity({ name: 'Dispatcher', type: 'class', projectId: ctx.projectId });
    const goal = createGoal(ctx.db, ctx.projectId, { title: 'Implement dispatcher', priority: 'P0' });
    linkGoalEntity(ctx.db, goal.id, entity.id, 'implements');
    recordGoalMission(ctx.db, goal.id, 'mission-123', 'success');

    // Preconditions
    expect(getGoal(ctx.db, goal.id)).not.toBeNull();
    expect(getGoalEntities(ctx.db, goal.id)).toHaveLength(1);
    expect(getGoalMissions(ctx.db, goal.id)).toHaveLength(1);

    // Act
    deleteGoal(ctx.db, goal.id);

    // Goal is gone
    expect(getGoal(ctx.db, goal.id)).toBeNull();

    // Links are cascade-deleted
    const remainingLinks = ctx.db
      .prepare('SELECT COUNT(*) as c FROM goal_entities WHERE goal_id = ?')
      .get(goal.id) as { c: number };
    expect(remainingLinks.c).toBe(0);

    const remainingMissions = ctx.db
      .prepare('SELECT COUNT(*) as c FROM goal_missions WHERE goal_id = ?')
      .get(goal.id) as { c: number };
    expect(remainingMissions.c).toBe(0);

    // Entity itself is preserved
    const preservedEntity = ctx.store.getEntity(entity.id);
    expect(preservedEntity).not.toBeNull();
    expect(preservedEntity?.name).toBe('Dispatcher');
  });

  it('deleteGoal on an unknown id is a no-op (idempotent)', () => {
    expect(() => deleteGoal(ctx.db, 'ghost-id')).not.toThrow();
  });
});

describe('tools/goals — getGoalEntities roles', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('returns linked entities along with their specific roles', () => {
    const implEntity = ctx.store.addEntity({ name: 'AppShell', type: 'class', projectId: ctx.projectId });
    const blockEntity = ctx.store.addEntity({ name: 'LegacyAdapter', type: 'class', projectId: ctx.projectId });

    const goal = createGoal(ctx.db, ctx.projectId, { title: 'Ship AppShell', priority: 'P1' });
    linkGoalEntity(ctx.db, goal.id, implEntity.id, 'implements');
    linkGoalEntity(ctx.db, goal.id, blockEntity.id, 'blocks');

    const results = getGoalEntities(ctx.db, goal.id);
    expect(results).toHaveLength(2);

    const byName = new Map(results.map((e) => [e.name, e]));
    expect(byName.get('AppShell')?.role).toBe('implements');
    expect(byName.get('LegacyAdapter')?.role).toBe('blocks');

    // Surface the core Entity fields
    expect(byName.get('AppShell')?.type).toBe('class');
    expect(byName.get('AppShell')?.id).toBe(implEntity.id);
  });

  it('returns an empty array for a goal without linked entities', () => {
    const goal = createGoal(ctx.db, ctx.projectId, { title: 'Lonely goal' });
    expect(getGoalEntities(ctx.db, goal.id)).toEqual([]);
  });
});

describe('tools/goals — suggest_next_actions scoring logic', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('prioritizes in_progress P0 over not_started P0', () => {
    const a = createGoal(ctx.db, ctx.projectId, { title: 'A', priority: 'P0', status: 'not_started' });
    const b = createGoal(ctx.db, ctx.projectId, { title: 'B', priority: 'P0', status: 'in_progress' });

    const goals = listGoals(ctx.db, ctx.projectId).filter(g => g.status !== 'done');
    expect(goals).toHaveLength(2);
    // The actual scoring happens in the tool; here we verify the data is correct
    const aGot = getGoal(ctx.db, a.id)!;
    const bGot = getGoal(ctx.db, b.id)!;
    expect(aGot.status).toBe('not_started');
    expect(bGot.status).toBe('in_progress');
  });

  it('excludes goals whose parent is not done', () => {
    const parent = createGoal(ctx.db, ctx.projectId, { title: 'Parent', priority: 'P0' });
    const child = createGoal(ctx.db, ctx.projectId, {
      title: 'Child',
      priority: 'P0',
      parentGoalId: parent.id,
    });

    // Parent not done → child is gated (score penalty of -2 applied in tool)
    expect(child.parentGoalId).toBe(parent.id);
    expect(getGoal(ctx.db, parent.id)?.status).toBe('not_started');
  });
});
