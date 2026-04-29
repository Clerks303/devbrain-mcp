import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { SnapshotCorruptedError } from '../../src/db/snapshot-schema.js';

// Regression: restoreSnapshot used to JSON.parse and cast directly into the
// destructive DELETE+INSERT path. A corrupted payload would silently insert
// NULLs (SQLite is permissive) or partially apply before throwing — leaving
// the project half-restored. Now validated with Zod up front.
//
// Also: createSnapshot used to swallow listFileDigests/listIssues/listRules/
// listLessons errors with `/* table may not exist */`. Those tables ALWAYS
// exist after initDatabase. The swallow risked silently producing a snapshot
// with [] for one of those slices, which would then wipe live data on restore.

describe('Snapshot — payload validation & restore safety', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;
  let store: KnowledgeStore;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrain-snap-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = initDatabase(dbPath, 1536);
    store = new KnowledgeStore(db);
    const project = store.addProject({ name: 'test', path: '/tmp/x' });
    projectId = project.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createSnapshot throws on real errors instead of silently producing empty snapshot', () => {
    // Drop the lessons table to simulate schema drift / corruption.
    // The old code swallowed this with `/* table may not exist */` and
    // produced a snapshot with `lessons: []`. The new code lets the error
    // surface so the user knows their snapshot would be invalid.
    store.getDb().exec('DROP TABLE lessons');
    expect(() => store.createSnapshot(projectId, 'test')).toThrow();
  });

  it('createSnapshot serializes all live data (entities, observations, rules, lessons, issues, files)', () => {
    const e1 = store.addEntity({ name: 'AuthService', type: 'service', projectId });
    store.addObservation({ entityId: e1.id, content: 'observation 1' });
    store.addRule({ projectId, content: 'rule 1' });
    store.addLesson({ projectId, trigger: 'when X', action: 'do Y', outcome: 'positive' });
    store.addIssue({ projectId, type: 'bug', title: 'issue 1', severity: 'high' });
    store.upsertFileDigest({ projectId, path: 'src/foo.ts', summary: 'test file' });

    const snap = store.createSnapshot(projectId, 'full');
    const full = store.getSnapshot(snap.id);
    expect(full).toBeTruthy();
    const parsed = JSON.parse(full!.data);
    expect(parsed.entities.length).toBe(1);
    expect(parsed.observations.length).toBe(1);
    expect(parsed.rules.length).toBe(1);
    expect(parsed.lessons.length).toBe(1);
    expect(parsed.issues.length).toBe(1);
    expect(parsed.fileDigests.length).toBe(1);
  });

  it('restoreSnapshot rejects malformed JSON', () => {
    // Manually inject a snapshot row with invalid JSON
    const snapId = 'snap-bad-json';
    store.getDb().prepare(
      `INSERT INTO snapshots (id, project_id, label, data, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(snapId, projectId, 'corrupt', 'this is not json', new Date().toISOString());

    expect(() => store.restoreSnapshot(projectId, snapId)).toThrow(SnapshotCorruptedError);
  });

  it('restoreSnapshot rejects payload missing required fields', () => {
    // entity without an id — SQLite would silently insert NULL
    const badPayload = JSON.stringify({
      entities: [{ name: 'X', type: 'foo', createdAt: 'now', updatedAt: 'now' }], // missing id
    });
    const snapId = 'snap-missing-id';
    store.getDb().prepare(
      `INSERT INTO snapshots (id, project_id, label, data, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(snapId, projectId, 'corrupt', badPayload, new Date().toISOString());

    expect(() => store.restoreSnapshot(projectId, snapId)).toThrow(SnapshotCorruptedError);
  });

  it('restoreSnapshot rejects payload with wrong types (e.g. confidence as string)', () => {
    const badPayload = JSON.stringify({
      lessons: [{
        id: 'l1', projectId, trigger: 'x', action: 'y',
        confidence: 'not-a-number',
        createdAt: 'now', updatedAt: 'now',
      }],
    });
    const snapId = 'snap-bad-types';
    store.getDb().prepare(
      `INSERT INTO snapshots (id, project_id, label, data, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(snapId, projectId, 'corrupt', badPayload, new Date().toISOString());

    expect(() => store.restoreSnapshot(projectId, snapId)).toThrow(SnapshotCorruptedError);
  });

  it('restoreSnapshot succeeds and roundtrips entities, observations, rules, lessons, issues', () => {
    const e1 = store.addEntity({ name: 'EntA', type: 'class', projectId });
    store.addObservation({ entityId: e1.id, content: 'obs A' });
    store.addRule({ projectId, content: 'must Z', severity: 'must' });
    store.addLesson({ projectId, trigger: 'tr', action: 'ac', outcome: 'positive' });
    const issue = store.addIssue({ projectId, type: 'bug', title: 'I1', severity: 'high' });
    void issue;

    const snap = store.createSnapshot(projectId, 'before');

    // Mutate live state
    store.deleteEntity(e1.id);
    expect(store.listEntities(projectId)).toHaveLength(0);
    expect(store.listLessons(projectId)).toHaveLength(1); // Lessons survive entity deletion

    // Manually wipe lessons + issues to verify restore brings them back
    store.getDb().prepare('DELETE FROM lessons WHERE project_id = ?').run(projectId);
    store.getDb().prepare('DELETE FROM issues WHERE project_id = ?').run(projectId);

    const result = store.restoreSnapshot(projectId, snap.id);
    expect(result.entities).toBe(1);
    expect(result.lessons).toBe(1);
    expect(result.issues).toBe(1); // Regression: issues were DELETEd but never restored

    expect(store.listEntities(projectId)).toHaveLength(1);
    expect(store.listLessons(projectId)).toHaveLength(1);
    expect(store.listIssues(projectId)).toHaveLength(1);
  });

  it('restoreSnapshot brings back issues (regression: issues were deleted but never re-inserted)', () => {
    store.addIssue({ projectId, type: 'bug', title: 'critical bug', severity: 'critical' });
    expect(store.listIssues(projectId)).toHaveLength(1);

    const snap = store.createSnapshot(projectId, 'with-issues');

    // Wipe issues entirely
    store.getDb().prepare('DELETE FROM issues WHERE project_id = ?').run(projectId);
    expect(store.listIssues(projectId)).toHaveLength(0);

    store.restoreSnapshot(projectId, snap.id);
    const restored = store.listIssues(projectId);
    expect(restored).toHaveLength(1);
    expect(restored[0].title).toBe('critical bug');
    expect(restored[0].severity).toBe('critical');
  });
});
