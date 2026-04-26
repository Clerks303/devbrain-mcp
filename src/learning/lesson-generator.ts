import type { SessionEvent, Session } from '../types.js';
import type { KnowledgeStore } from '../db/store.js';
import type { VectorStore } from '../db/vector.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { GeneratedLesson } from './types.js';
import { LEARNING_SAFETY } from './types.js';

/**
 * Generate lessons from session events using heuristic rules.
 * No LLM required — purely based on event patterns.
 */
export async function generateLessons(
  session: Session,
  events: readonly SessionEvent[],
  store: KnowledgeStore,
  vectorStore: VectorStore,
  embeddingProvider: EmbeddingProvider,
): Promise<{ lessons: GeneratedLesson[]; deduped: number; contradictions: number }> {
  const candidates: GeneratedLesson[] = [];
  let deduped = 0;
  let contradictions = 0;

  // 1. Git revert detection
  for (const event of events) {
    if (event.type === 'tool_call' && event.content.includes('git.revert')) {
      const files = extractFilesFromMetadata(event);
      candidates.push({
        trigger: `Modification of ${files.join(', ') || 'files'}`,
        action: `Avoid: ${event.content}`,
        outcome: 'negative',
        confidence: 0.4,
        source: 'auto',
      });
    }
  }

  // 2. Quick fix — issue opened and resolved in same session
  try {
    const issues = store.listIssues(session.projectId, { status: 'resolved' });
    for (const issue of issues) {
      if (issue.metadata) {
        const meta = issue.metadata as Record<string, unknown>;
        if (meta.resolved_in_session === session.id) {
          candidates.push({
            trigger: `Bug type ${issue.type} on ${issue.filePath ?? 'unknown file'}`,
            action: issue.resolution ?? 'Quick fix applied',
            outcome: 'positive',
            confidence: 0.5,
            source: 'auto',
          });
        }
      }
    }
  } catch { /* ignore */ }

  // 3. Build failed → build passed in same session
  const buildFailIndex = events.findIndex(
    e => e.type === 'error' && e.content.includes('build_failure')
  );
  const buildPassIndex = events.findIndex(
    (e, i) => i > buildFailIndex && e.type === 'tool_call' && e.content.includes('build_success')
  );
  if (buildFailIndex >= 0 && buildPassIndex > buildFailIndex) {
    const failedFiles = extractFilesFromRange(events, buildFailIndex, buildPassIndex);
    candidates.push({
      trigger: `Build failed after modifying ${failedFiles.join(', ') || 'files'}`,
      action: 'Verify build after changes to these files',
      outcome: 'negative',
      confidence: 0.4,
      source: 'auto',
    });
  }

  // 4. Error → fix cycle (error event followed by successful tool calls without more errors)
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'error') continue;
    // Look for a fix: next 5 events should have tool_calls without errors
    const window = events.slice(i + 1, i + 6);
    const hasToolCalls = window.some(e => e.type === 'tool_call');
    const hasMoreErrors = window.some(e => e.type === 'error');
    if (hasToolCalls && !hasMoreErrors) {
      const errorFile = extractFilesFromMetadata(events[i]).join(', ');
      if (errorFile) {
        candidates.push({
          trigger: `Error in ${errorFile}`,
          action: 'Check for similar errors when modifying this file',
          outcome: 'negative',
          confidence: 0.4,
          source: 'auto',
        });
      }
    }
  }

  // Limit candidates
  const limitedCandidates = candidates.slice(0, LEARNING_SAFETY.MAX_AUTO_LESSONS_PER_SESSION);

  // Deduplicate and check contradictions
  const finalLessons: GeneratedLesson[] = [];
  for (const candidate of limitedCandidates) {
    const { isDuplicate, isContradiction } = await checkDuplicateOrContradiction(
      candidate, session.projectId, store, vectorStore, embeddingProvider,
    );
    if (isDuplicate) {
      deduped++;
      continue;
    }
    if (isContradiction) {
      contradictions++;
      continue;
    }
    finalLessons.push(candidate);
  }

  return { lessons: finalLessons, deduped, contradictions };
}

/** Check if a candidate lesson is a duplicate or contradiction of existing lessons */
async function checkDuplicateOrContradiction(
  candidate: GeneratedLesson,
  projectId: string,
  store: KnowledgeStore,
  vectorStore: VectorStore,
  embeddingProvider: EmbeddingProvider,
): Promise<{ isDuplicate: boolean; isContradiction: boolean }> {
  try {
    const text = `${candidate.trigger} ${candidate.action}`;
    const embedding = await embeddingProvider.embed(text);
    const results = vectorStore.searchLessons(embedding, 3);

    for (const result of results) {
      const existing = store.getLesson(result.id);
      if (!existing || existing.projectId !== projectId) continue;

      // Duplicate: same direction, very similar
      if (result.distance < LEARNING_SAFETY.DEDUP_COSINE_THRESHOLD) {
        if (existing.outcome === candidate.outcome || existing.outcome === 'neutral') {
          // Reinforce existing instead
          store.reinforceLesson(result.id);
          return { isDuplicate: true, isContradiction: false };
        }
      }

      // Contradiction: opposite outcome, similar content, high confidence
      if (
        result.distance < LEARNING_SAFETY.CONTRADICTION_COSINE_THRESHOLD &&
        existing.outcome !== candidate.outcome &&
        existing.outcome !== 'neutral' &&
        existing.confidence > 0.6
      ) {
        return { isDuplicate: false, isContradiction: true };
      }
    }
  } catch {
    // If embedding fails, skip dedup check
  }

  return { isDuplicate: false, isContradiction: false };
}

function extractFilesFromMetadata(event: SessionEvent): string[] {
  if (!event.metadata) return [];
  const meta = event.metadata as Record<string, unknown>;
  const filePath = meta.file_path as string | undefined;
  return filePath ? [filePath] : [];
}

function extractFilesFromRange(events: readonly SessionEvent[], start: number, end: number): string[] {
  const files = new Set<string>();
  for (let i = start; i <= end && i < events.length; i++) {
    for (const f of extractFilesFromMetadata(events[i])) {
      files.add(f);
    }
  }
  return [...files];
}
