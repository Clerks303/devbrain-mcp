import { z } from 'zod';

/**
 * Zod schema for snapshot payload validation.
 *
 * Snapshots are JSON blobs persisted in the `snapshots.data` column. They are
 * the input to a destructive `DELETE … WHERE project_id = ? + INSERT` cycle in
 * `restoreSnapshot`. Without validation, a corrupted snapshot or one produced
 * by an incompatible version of devbrain would silently feed `undefined` into
 * `INSERT` statements (SQLite happily writes NULLs) or, worse, partially apply
 * before throwing on a missing field — leaving the project in a half-restored
 * state.
 *
 * The schema is intentionally lenient on optional fields (most metadata is
 * nullable) but strict on identity fields (id, projectId, content) that are
 * required for the INSERTs to succeed.
 *
 * Unknown extra fields are stripped, not rejected, so older snapshots that
 * include legacy keys remain restorable.
 */

const EntityItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  projectId: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  status: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ObservationItemSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  content: z.string(),
  source: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  createdAt: z.string(),
});

const RelationItemSchema = z.object({
  id: z.string().min(1),
  fromEntityId: z.string().min(1),
  toEntityId: z.string().min(1),
  type: z.string(),
  weight: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
});

const FileDigestItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  path: z.string(),
  contentHash: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  exports: z.array(z.string()).nullable().optional(),
  imports: z.array(z.string()).nullable().optional(),
  language: z.string().nullable().optional(),
  loc: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const IssueItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  entityId: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  type: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RuleItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  scope: z.string().nullable().optional(),
  pattern: z.string().nullable().optional(),
  content: z.string(),
  severity: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const LessonItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  trigger: z.string(),
  action: z.string(),
  outcome: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  occurrences: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SnapshotPayloadSchema = z.object({
  entities: z.array(EntityItemSchema).optional(),
  observations: z.array(ObservationItemSchema).optional(),
  relations: z.array(RelationItemSchema).optional(),
  fileDigests: z.array(FileDigestItemSchema).optional(),
  issues: z.array(IssueItemSchema).optional(),
  rules: z.array(RuleItemSchema).optional(),
  lessons: z.array(LessonItemSchema).optional(),
});

export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

export class SnapshotCorruptedError extends Error {
  constructor(public readonly snapshotId: string, public readonly issues: string[]) {
    super(
      `Snapshot ${snapshotId} payload is corrupted or incompatible — refusing to restore. ` +
      `Issues: ${issues.join('; ')}`,
    );
    this.name = 'SnapshotCorruptedError';
  }
}
