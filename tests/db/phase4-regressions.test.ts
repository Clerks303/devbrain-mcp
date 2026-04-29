import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';

const DIM = 4;

interface Ctx {
  db: Database.Database;
  store: KnowledgeStore;
  vectorStore: VectorStore;
  projectId: string;
  cleanup: () => void;
}

function setup(): Ctx {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-phase4-'));
  const dbPath = path.join(tmp, 'test.db');
  const db = initDatabase(dbPath, DIM);
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);
  const project = store.addProject({ name: 'test', path: '/tmp/test' });
  return {
    db,
    store,
    vectorStore,
    projectId: project.id,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function unitVector(seed: number): number[] {
  const v = Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)) + 1.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

describe('Phase 4-B — cursor pagination indexes', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('creates the entities composite index for cursor pagination', () => {
    const indexes = ctx.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities'`,
    ).all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain('idx_entities_project_updated_id');
  });

  it('creates the issues composite index for cursor pagination', () => {
    const indexes = ctx.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'issues'`,
    ).all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain('idx_issues_project_created_id');
  });
});

describe('Phase 4-C — VectorStore upsert atomicity', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('upsertEntityEmbedding replaces an existing row in a single transaction', () => {
    const entity = ctx.store.addEntity({ name: 'A', type: 'function', projectId: ctx.projectId });
    ctx.vectorStore.upsertEntityEmbedding(entity.id, unitVector(1));
    ctx.vectorStore.upsertEntityEmbedding(entity.id, unitVector(2)); // overwrite

    const rows = ctx.db.prepare(
      `SELECT id FROM entity_embeddings WHERE id = ?`,
    ).all(entity.id);
    expect(rows.length).toBe(1);
  });

  it('reuses a single cached transaction wrapper across upsert calls', () => {
    const e1 = ctx.store.addEntity({ name: 'B1', type: 'function', projectId: ctx.projectId });
    const e2 = ctx.store.addEntity({ name: 'B2', type: 'function', projectId: ctx.projectId });

    // No throw across multiple calls — the cached prepared+transaction is reusable.
    expect(() => {
      ctx.vectorStore.upsertEntityEmbedding(e1.id, unitVector(3));
      ctx.vectorStore.upsertEntityEmbedding(e2.id, unitVector(4));
      ctx.vectorStore.upsertEntityEmbedding(e1.id, unitVector(5));
    }).not.toThrow();

    const count = (ctx.db.prepare(`SELECT COUNT(*) as c FROM entity_embeddings`).get() as { c: number }).c;
    expect(count).toBe(2);
  });
});

describe('Phase 4-D — batch helpers eliminate N+1', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('getEntitiesByIds returns entities filtered by projectId and types', () => {
    const a = ctx.store.addEntity({ name: 'fnA', type: 'function', projectId: ctx.projectId });
    const b = ctx.store.addEntity({ name: 'clB', type: 'class', projectId: ctx.projectId });
    const c = ctx.store.addEntity({ name: 'fnC', type: 'function', projectId: null });

    const all = ctx.store.getEntitiesByIds([a.id, b.id, c.id]);
    expect(all.map(e => e.id).sort()).toEqual([a.id, b.id, c.id].sort());

    // Project filter mirrors listEntities semantics: includes the project's own
    // entities AND null-project (global) ones. Combined with types=['function'],
    // we keep both `a` (project + function) and `c` (global + function).
    const fns = ctx.store.getEntitiesByIds([a.id, b.id, c.id], {
      projectId: ctx.projectId,
      types: ['function'],
    });
    expect(fns.map(e => e.id).sort()).toEqual([a.id, c.id].sort());
  });

  it('getObservationsGroupedByEntityIds groups in one query', () => {
    const a = ctx.store.addEntity({ name: 'A', type: 'function', projectId: ctx.projectId });
    const b = ctx.store.addEntity({ name: 'B', type: 'function', projectId: ctx.projectId });
    ctx.store.addObservation({ entityId: a.id, content: 'a1' });
    ctx.store.addObservation({ entityId: a.id, content: 'a2' });
    ctx.store.addObservation({ entityId: b.id, content: 'b1' });

    const grouped = ctx.store.getObservationsGroupedByEntityIds([a.id, b.id]);
    expect(grouped.get(a.id)?.length).toBe(2);
    expect(grouped.get(b.id)?.length).toBe(1);
  });

  it('getObservationEntityIds resolves observation→entity in one query', () => {
    const a = ctx.store.addEntity({ name: 'A', type: 'function', projectId: ctx.projectId });
    const o1 = ctx.store.addObservation({ entityId: a.id, content: 'x' });
    const o2 = ctx.store.addObservation({ entityId: a.id, content: 'y' });

    const map = ctx.store.getObservationEntityIds([o1.id, o2.id]);
    expect(map.get(o1.id)).toBe(a.id);
    expect(map.get(o2.id)).toBe(a.id);
  });

  it('returns empty maps/arrays for empty id lists without querying', () => {
    expect(ctx.store.getEntitiesByIds([])).toEqual([]);
    expect(ctx.store.getObservationsGroupedByEntityIds([]).size).toBe(0);
    expect(ctx.store.getObservationEntityIds([]).size).toBe(0);
    expect(ctx.store.getIssueEntityIds([]).size).toBe(0);
  });

  it('createSnapshot includes more than the default listX limit (no silent truncation)', () => {
    // Default list limit is 100. Insert >100 of each truncatable type to verify
    // the snapshot uses SNAPSHOT_LIMIT and captures the full project state.
    for (let i = 0; i < 105; i++) {
      ctx.store.addRule({
        projectId: ctx.projectId,
        scope: 'global',
        content: `rule-${i}`,
        severity: 'should',
      });
    }

    const snapshot = ctx.store.createSnapshot(ctx.projectId, 'phase4-test');
    const data = JSON.parse(snapshot.data) as { rules: unknown[] };
    expect(data.rules.length).toBe(105);
  });
});
