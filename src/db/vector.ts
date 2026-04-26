import type Database from 'better-sqlite3';
import type { SearchResult } from '../types.js';

export function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export class VectorStore {
  constructor(private db: Database.Database) {}

  upsertEntityEmbedding(id: string, embedding: number[]): void {
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM entity_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO entity_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  upsertObservationEmbedding(id: string, embedding: number[]): void {
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM observation_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO observation_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  searchEntities(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    const blob = vectorToBlob(queryEmbedding);
    const rows = this.db.prepare(`
      SELECT id, distance FROM entity_embeddings
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(blob, limit) as { id: string; distance: number }[];

    return rows.map(r => ({ id: r.id, distance: r.distance }));
  }

  searchObservations(queryEmbedding: number[], limit: number = 10): SearchResult[] {
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
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM file_digest_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO file_digest_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  searchFileDigests(queryEmbedding: number[], limit: number = 10): SearchResult[] {
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
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM issue_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO issue_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  searchIssues(queryEmbedding: number[], limit: number = 10): SearchResult[] {
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
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM session_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO session_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  searchSessions(queryEmbedding: number[], limit: number = 10): SearchResult[] {
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
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM rule_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO rule_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  searchRules(queryEmbedding: number[], limit: number = 10): SearchResult[] {
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
    const blob = vectorToBlob(embedding);
    this.db.prepare('DELETE FROM lesson_embeddings WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO lesson_embeddings (id, embedding) VALUES (?, ?)').run(id, blob);
  }

  searchLessons(queryEmbedding: number[], limit: number = 10): SearchResult[] {
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
