import type Database from 'better-sqlite3';
import type { SearchResult } from '../types.js';

export function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

// Empty embeddings (length 0) come from the NoOp provider when no embedding
// backend is configured. Skipping the upsert keeps the KNN index clean —
// indexing zero vectors would put every row at cosine distance 1 and bias search.
function isEmpty(embedding: number[]): boolean {
  return !embedding || embedding.length === 0;
}

export class VectorStore {
  // Cache of (delete + insert) transactions per table. vec0 doesn't accept
  // INSERT OR REPLACE, so we DELETE then INSERT. Wrapping the pair in a
  // db.transaction makes it atomic — a process crash between the two
  // statements used to leave the row absent and silently broke recall.
  // The cache also avoids re-preparing statements on every embed call.
  private readonly upsertTxCache = new Map<string, (id: string, blob: Buffer) => void>();

  constructor(private db: Database.Database) {}

  private getUpsertTx(table: string): (id: string, blob: Buffer) => void {
    const cached = this.upsertTxCache.get(table);
    if (cached) return cached;
    const del = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    const ins = this.db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`);
    const tx = this.db.transaction((id: string, blob: Buffer) => {
      del.run(id);
      ins.run(id, blob);
    });
    this.upsertTxCache.set(table, tx);
    return tx;
  }

  private upsertEmbedding(table: string, id: string, embedding: number[]): void {
    if (isEmpty(embedding)) return;
    this.getUpsertTx(table)(id, vectorToBlob(embedding));
  }

  upsertEntityEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('entity_embeddings', id, embedding);
  }

  upsertObservationEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('observation_embeddings', id, embedding);
  }

  searchEntities(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM entity_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];

    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  searchObservations(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM observation_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];

    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  deleteEntityEmbedding(id: string): void {
    this.db.prepare('DELETE FROM entity_embeddings WHERE id = ?').run(id);
  }

  deleteObservationEmbedding(id: string): void {
    this.db.prepare('DELETE FROM observation_embeddings WHERE id = ?').run(id);
  }

  // --- File Digest Embeddings ---

  upsertFileDigestEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('file_digest_embeddings', id, embedding);
  }

  searchFileDigests(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM file_digest_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];

    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  deleteFileDigestEmbedding(id: string): void {
    this.db.prepare('DELETE FROM file_digest_embeddings WHERE id = ?').run(id);
  }

  // --- Issue Embeddings ---

  upsertIssueEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('issue_embeddings', id, embedding);
  }

  searchIssues(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM issue_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];

    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  deleteIssueEmbedding(id: string): void {
    this.db.prepare('DELETE FROM issue_embeddings WHERE id = ?').run(id);
  }

  // --- Session Embeddings ---

  upsertSessionEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('session_embeddings', id, embedding);
  }

  searchSessions(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM session_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];
    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  deleteSessionEmbedding(id: string): void {
    this.db.prepare('DELETE FROM session_embeddings WHERE id = ?').run(id);
  }

  // --- Rule Embeddings ---

  upsertRuleEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('rule_embeddings', id, embedding);
  }

  searchRules(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM rule_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];
    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  deleteRuleEmbedding(id: string): void {
    this.db.prepare('DELETE FROM rule_embeddings WHERE id = ?').run(id);
  }

  // --- Lesson Embeddings ---

  upsertLessonEmbedding(id: string, embedding: number[]): void {
    this.upsertEmbedding('lesson_embeddings', id, embedding);
  }

  searchLessons(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (isEmpty(queryEmbedding)) return [];
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM lesson_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];
    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  deleteLessonEmbedding(id: string): void {
    this.db.prepare('DELETE FROM lesson_embeddings WHERE id = ?').run(id);
  }
}
