import { createHash } from 'node:crypto';
import type { SessionEvent, Session } from '../types.js';
import type { ExtractedPattern } from './types.js';

/**
 * Extract action N-grams from session events.
 * Sliding window of size N over tool_name sequences.
 */
export function extractActionNgrams(events: readonly SessionEvent[], n = 3): Map<string, number> {
  const toolNames = events
    .filter(e => e.type === 'tool_call' && e.toolName !== null)
    .map(e => e.toolName!);

  const ngrams = new Map<string, number>();
  for (let i = 0; i <= toolNames.length - n; i++) {
    const gram = canonicalizeNgram(toolNames.slice(i, i + n));
    ngrams.set(gram, (ngrams.get(gram) ?? 0) + 1);
  }
  return ngrams;
}

/** Canonicalize tool names: strip arguments to reduce noise */
export function canonicalizeNgram(ngram: readonly string[]): string {
  return ngram.map(s => s.replace(/:[^\s]+$/, ':ARG')).join(' → ');
}

/** Stable hash for pattern deduplication */
export function patternSignature(canonical: string): string {
  return createHash('sha1').update(canonical).digest('hex').substring(0, 16);
}

/**
 * Extract file co-occurrence patterns from session events.
 * Files modified in the same session are paired and counted.
 */
export function extractFileCooccurrences(
  sessionEvents: ReadonlyArray<readonly SessionEvent[]>,
): Map<string, number> {
  const pairCounts = new Map<string, number>();

  for (const events of sessionEvents) {
    const files = new Set<string>();
    for (const event of events) {
      if (event.type === 'tool_call' && event.metadata) {
        const filePath = (event.metadata as Record<string, unknown>).file_path as string | undefined;
        if (filePath) files.add(filePath);
      }
    }

    const fileList = [...files].sort();
    for (let i = 0; i < fileList.length; i++) {
      for (let j = i + 1; j < fileList.length; j++) {
        const pair = `${fileList[i]} ↔ ${fileList[j]}`;
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
    }
  }

  return pairCounts;
}

/**
 * Extract error-file associations from session events.
 * Correlates files modified close to error events.
 */
export function extractErrorFileAssociations(
  events: readonly SessionEvent[],
): Map<string, number> {
  const associations = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'error') continue;

    // Look at surrounding events (5 before, 5 after) for file modifications
    const start = Math.max(0, i - 5);
    const end = Math.min(events.length, i + 6);

    for (let j = start; j < end; j++) {
      if (j === i) continue;
      if (events[j].type === 'tool_call' && events[j].metadata) {
        const filePath = (events[j].metadata as Record<string, unknown>).file_path as string | undefined;
        if (filePath) {
          const key = `${filePath} ↔ error`;
          associations.set(key, (associations.get(key) ?? 0) + 1);
        }
      }
    }
  }

  return associations;
}

/**
 * Full pattern extraction pipeline for a session.
 * Returns patterns that meet minimum thresholds.
 */
export function extractPatterns(
  session: Session,
  currentEvents: readonly SessionEvent[],
  recentSessionEvents: ReadonlyArray<{ sessionId: string; events: readonly SessionEvent[] }>,
  minOccurrences = 3,
): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];

  // 1. Action N-grams across all sessions
  const allNgrams = new Map<string, { count: number; sessions: Set<string> }>();
  const allSessionData = [
    { sessionId: session.id, events: currentEvents },
    ...recentSessionEvents,
  ];

  for (const { sessionId, events } of allSessionData) {
    const ngrams = extractActionNgrams(events);
    for (const [gram, count] of ngrams) {
      const existing = allNgrams.get(gram) ?? { count: 0, sessions: new Set() };
      existing.count += count;
      existing.sessions.add(sessionId);
      allNgrams.set(gram, existing);
    }
  }

  for (const [gram, data] of allNgrams) {
    if (data.sessions.size >= minOccurrences) {
      patterns.push({
        type: 'action_sequence',
        signature: patternSignature(gram),
        description: `Recurring action sequence: ${gram} (seen in ${data.sessions.size} sessions)`,
        evidence: [...data.sessions],
      });
    }
  }

  // 2. File co-occurrences
  const allEvents = allSessionData.map(s => s.events);
  const cooccurrences = extractFileCooccurrences(allEvents);

  for (const [pair, count] of cooccurrences) {
    if (count >= minOccurrences) {
      patterns.push({
        type: 'file_cooccurrence',
        signature: patternSignature(pair),
        description: `Files frequently modified together: ${pair} (${count}× across sessions)`,
        evidence: allSessionData.map(s => s.sessionId).slice(0, 5),
      });
    }
  }

  // 3. Error-file associations
  const errorAssociations = extractErrorFileAssociations(currentEvents);
  for (const [key, count] of errorAssociations) {
    if (count >= 2) {
      patterns.push({
        type: 'error_file_association',
        signature: patternSignature(key),
        description: `File associated with errors: ${key} (${count}×)`,
        evidence: [session.id],
      });
    }
  }

  return patterns;
}
