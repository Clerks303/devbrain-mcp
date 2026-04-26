import type { KnowledgeStore } from '../db/store.js';
import type { LearningStore } from './learning-store.js';
import type { Session, SessionEvent } from '../types.js';
import type { DeveloperProfile } from './types.js';
import { emaUpdate } from './context-ranker.js';

const MIN_SESSIONS_FOR_PROFILE = 5;
const EMA_ALPHA = 0.1;

/**
 * Update the developer profile incrementally after a session ends.
 * Uses EMA to smooth statistics over time.
 */
export function updateProfile(
  projectId: string,
  session: Session,
  events: readonly SessionEvent[],
  store: KnowledgeStore,
  learningStore: LearningStore,
): DeveloperProfile | null {
  const existing = learningStore.getProfile(projectId);
  const sessionCount = (existing?.sessionCount ?? 0) + 1;

  // Don't generate profile until minimum sessions reached
  if (sessionCount < MIN_SESSIONS_FOR_PROFILE && !existing) {
    return null;
  }

  const profile = existing ?? createEmptyProfile();
  const updated = computeUpdatedProfile(profile, session, events, store, sessionCount);

  learningStore.upsertProfile(projectId, updated);
  return updated;
}

function createEmptyProfile(): DeveloperProfile {
  return {
    primaryLanguages: [],
    frequentlyEditedFilePatterns: [],
    avgSessionDurationMinutes: 0,
    avgToolCallsPerSession: 0,
    avgEntitiesModifiedPerSession: 0,
    frequentIssueTypes: [],
    issueProneFilePatterns: [],
    tendencies: [],
    lastUpdatedAt: new Date().toISOString(),
    sessionCount: 0,
  };
}

function computeUpdatedProfile(
  prev: DeveloperProfile,
  session: Session,
  events: readonly SessionEvent[],
  store: KnowledgeStore,
  sessionCount: number,
): DeveloperProfile {
  // Session duration
  const durationMinutes = session.endedAt
    ? (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000
    : 0;

  const avgSessionDurationMinutes = emaUpdate(prev.avgSessionDurationMinutes, durationMinutes, EMA_ALPHA);
  const avgToolCallsPerSession = emaUpdate(prev.avgToolCallsPerSession, session.toolCalls, EMA_ALPHA);
  const avgEntitiesModifiedPerSession = emaUpdate(prev.avgEntitiesModifiedPerSession, session.entitiesModified, EMA_ALPHA);

  // Language detection from file digests
  const primaryLanguages = inferPrimaryLanguages(store, session.projectId);

  // Frequently edited file patterns from events
  const frequentlyEditedFilePatterns = inferFilePatterns(events, prev.frequentlyEditedFilePatterns);

  // Issue types
  const frequentIssueTypes = inferIssueTypes(store, session.projectId);

  // Issue-prone files
  const issueProneFilePatterns = inferIssueProneFiles(store, session.projectId);

  // Tendencies
  const tendencies = inferTendencies({
    avgSessionDurationMinutes,
    avgToolCallsPerSession,
    frequentlyEditedFilePatterns,
    frequentIssueTypes,
  });

  return {
    primaryLanguages,
    frequentlyEditedFilePatterns,
    avgSessionDurationMinutes,
    avgToolCallsPerSession,
    avgEntitiesModifiedPerSession,
    frequentIssueTypes,
    issueProneFilePatterns,
    tendencies,
    lastUpdatedAt: new Date().toISOString(),
    sessionCount,
  };
}

function inferPrimaryLanguages(store: KnowledgeStore, projectId: string): string[] {
  try {
    const db = store.getDb();
    const rows = db.prepare(`
      SELECT language, COUNT(*) as count FROM file_digests
      WHERE project_id = ? AND language IS NOT NULL AND status = 'active'
      GROUP BY language ORDER BY count DESC LIMIT 5
    `).all(projectId) as Array<{ language: string; count: number }>;
    return rows.map(r => r.language);
  } catch {
    return [];
  }
}

function inferFilePatterns(
  events: readonly SessionEvent[],
  previousPatterns: readonly string[],
): string[] {
  const extensions = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'tool_call' || !event.metadata) continue;
    const filePath = (event.metadata as Record<string, unknown>).file_path as string | undefined;
    if (!filePath) continue;
    const ext = filePath.split('.').pop();
    if (ext) {
      extensions.set(`*.${ext}`, (extensions.get(`*.${ext}`) ?? 0) + 1);
    }
  }

  const sorted = [...extensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pattern]) => pattern);

  // Merge with previous, keeping top 10
  const merged = new Set([...sorted, ...previousPatterns]);
  return [...merged].slice(0, 10);
}

function inferIssueTypes(
  store: KnowledgeStore,
  projectId: string,
): Array<{ type: string; count: number; resolvedRate: number }> {
  try {
    const db = store.getDb();
    const rows = db.prepare(`
      SELECT type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved
      FROM issues WHERE project_id = ?
      GROUP BY type ORDER BY total DESC LIMIT 5
    `).all(projectId) as Array<{ type: string; total: number; resolved: number }>;

    return rows.map(r => ({
      type: r.type,
      count: r.total,
      resolvedRate: r.total > 0 ? r.resolved / r.total : 0,
    }));
  } catch {
    return [];
  }
}

function inferIssueProneFiles(store: KnowledgeStore, projectId: string): string[] {
  try {
    const db = store.getDb();
    const rows = db.prepare(`
      SELECT file_path, COUNT(*) as count FROM issues
      WHERE project_id = ? AND file_path IS NOT NULL
      GROUP BY file_path HAVING count >= 2
      ORDER BY count DESC LIMIT 10
    `).all(projectId) as Array<{ file_path: string; count: number }>;
    return rows.map(r => r.file_path);
  } catch {
    return [];
  }
}

function inferTendencies(stats: {
  avgSessionDurationMinutes: number;
  avgToolCallsPerSession: number;
  frequentlyEditedFilePatterns: readonly string[];
  frequentIssueTypes: readonly { type: string; count: number; resolvedRate: number }[];
}): Array<{ description: string; confidence: number }> {
  const tendencies: Array<{ description: string; confidence: number }> = [];

  if (stats.avgSessionDurationMinutes < 30 && stats.avgToolCallsPerSession < 10) {
    tendencies.push({ description: 'Short, focused sessions', confidence: 0.7 });
  }

  if (stats.avgSessionDurationMinutes > 120) {
    tendencies.push({ description: 'Long exploration sessions', confidence: 0.6 });
  }

  const hasTestFiles = stats.frequentlyEditedFilePatterns.some(
    p => p.includes('test') || p.includes('spec')
  );
  if (hasTestFiles) {
    tendencies.push({ description: 'Regular testing practice', confidence: 0.6 });
  }

  const typeErrors = stats.frequentIssueTypes.find(i => i.type === 'type');
  if (typeErrors && typeErrors.count >= 3) {
    tendencies.push({ description: 'Frequent type errors', confidence: 0.5 });
  }

  return tendencies;
}
