import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase } from '../../src/db/schema.js';
import { fetchContext } from '../../src/injector/context-fetcher.js';
import type { PromptAnalysis } from '../../src/injector/types.js';

// Regression: the previous version joined `e.id = ef.rowid` (UUID TEXT vs INTEGER rowid),
// which silently returned zero FTS matches. Same bug on lessons + missing lessons_fts table.
// These tests exercise the real schema + injector path end-to-end.

describe('context-fetcher — FTS regression', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-fetcher-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAnalysis(overrides: Partial<PromptAnalysis> = {}): PromptAnalysis {
    return {
      rawPrompt: '',
      intent: 'implement',
      mentionedFiles: [],
      mentionedIdentifiers: [],
      keywords: [],
      language: 'en',
      confidence: 0.8,
      ...overrides,
    };
  }

  it('fetchEntities returns FTS matches (regression: e.rowid = ef.rowid)', () => {
    const db = initDatabase(dbPath, 1536);

    const projectId = 'p-1';
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
      projectId, 'test', new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO entities (id, name, type, project_id, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('e-auth', 'AuthService', 'service', projectId, 'JWT authentication handler', 'active',
      new Date().toISOString(), new Date().toISOString());

    db.prepare(
      `INSERT INTO entities (id, name, type, project_id, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('e-other', 'PaymentGateway', 'service', projectId, 'Stripe integration', 'active',
      new Date().toISOString(), new Date().toISOString());

    const analysis = makeAnalysis({ keywords: ['authentication'] });
    const ctx = fetchContext(db, projectId, analysis);

    const ids = ctx.entities.map(e => e.id);
    expect(ids).toContain('e-auth');
    expect(ids).not.toContain('e-other');
    // Source must be 'fts' — proves the FTS join worked, not a name_match fallback
    const auth = ctx.entities.find(e => e.id === 'e-auth');
    expect(auth?.source).toBe('fts');

    db.close();
  });

  it('fetchLessons returns FTS matches (regression: lessons_fts created + l.rowid join + trigger_text alias)', () => {
    const db = initDatabase(dbPath, 1536);

    const projectId = 'p-1';
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
      projectId, 'test', new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO lessons (id, project_id, trigger_text, action, outcome, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('l-1', projectId, 'When adding OAuth providers', 'Always isolate via adapter pattern',
      'positive', 0.8, new Date().toISOString(), new Date().toISOString());

    db.prepare(
      `INSERT INTO lessons (id, project_id, trigger_text, action, outcome, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('l-2', projectId, 'Database migration', 'Use idempotent ALTER',
      'positive', 0.7, new Date().toISOString(), new Date().toISOString());

    const analysis = makeAnalysis({ keywords: ['oauth'] });
    const ctx = fetchContext(db, projectId, analysis);

    const ids = ctx.lessons.map(l => l.id);
    expect(ids).toContain('l-1');
    expect(ids).not.toContain('l-2');

    // The SELECT must alias trigger_text → trigger; verify shape
    const lesson = ctx.lessons.find(l => l.id === 'l-1');
    expect(lesson?.trigger).toBe('When adding OAuth providers');
    expect(lesson?.action).toBe('Always isolate via adapter pattern');

    db.close();
  });

  it('fetchLessons filters by confidence threshold', () => {
    const db = initDatabase(dbPath, 1536);

    const projectId = 'p-1';
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
      projectId, 'test', new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO lessons (id, project_id, trigger_text, action, outcome, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('l-low', projectId, 'OAuth flow setup', 'Try various approaches',
      'neutral', 0.2, new Date().toISOString(), new Date().toISOString());

    const analysis = makeAnalysis({ keywords: ['oauth'] });
    const ctx = fetchContext(db, projectId, analysis);

    expect(ctx.lessons.find(l => l.id === 'l-low')).toBeUndefined();
    db.close();
  });

  it('lessons_fts is backfilled for pre-existing rows', () => {
    // Simulate "DB created before lessons_fts existed": insert lessons, then trigger initDatabase again.
    const db1 = initDatabase(dbPath, 1536);
    const projectId = 'p-1';
    db1.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
      projectId, 'test', new Date().toISOString(),
    );
    db1.prepare(
      `INSERT INTO lessons (id, project_id, trigger_text, action, outcome, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('l-pre', projectId, 'Caching strategy decision', 'Use Redis with TTL',
      'positive', 0.9, new Date().toISOString(), new Date().toISOString());

    // Force rebuild flag off and drop FTS to simulate pre-migration state
    db1.exec("DELETE FROM meta WHERE key = 'lessons_fts_backfilled'");
    db1.exec('DROP TABLE IF EXISTS lessons_fts');
    db1.close();

    // Reopen — should recreate lessons_fts AND backfill from existing rows
    const db2 = initDatabase(dbPath, 1536);
    const analysis = makeAnalysis({ keywords: ['caching'] });
    const ctx = fetchContext(db2, projectId, analysis);
    expect(ctx.lessons.map(l => l.id)).toContain('l-pre');
    db2.close();
  });
});
