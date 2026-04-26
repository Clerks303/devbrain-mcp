import type { PromptAnalysis, FetchedContext, ScoredItem } from './types.js';

/** Intent-to-entity-type boost mapping */
const INTENT_TYPE_BOOSTS: Readonly<Record<string, string[]>> = {
  implement: ['module', 'pattern', 'service', 'component'],
  refactor: ['decision', 'architecture', 'module', 'pattern'],
  debug: ['issue', 'error', 'service', 'module'],
  review: ['rule', 'convention', 'pattern'],
  architecture: ['architecture', 'decision', 'module', 'system'],
  generic: [],
};

/** Score all fetched context items and return sorted scored items */
export function scoreContext(
  analysis: PromptAnalysis,
  context: FetchedContext,
): ScoredItem[] {
  const items: ScoredItem[] = [];
  const mentionedNames = new Set(
    analysis.mentionedIdentifiers.map(id => id.toLowerCase())
  );
  const intentBoosts = INTENT_TYPE_BOOSTS[analysis.intent] ?? [];

  // Score rules
  for (const rule of context.rules) {
    const baseScore = rule.severity === 'must' ? 1.0 : rule.severity === 'should' ? 0.7 : 0.4;
    items.push({
      category: 'rule',
      score: baseScore,
      text: `[${rule.severity.toUpperCase()}] ${rule.content}`,
      id: rule.id,
    });
  }

  // Score entities
  for (const entity of context.entities) {
    let score = entity.source === 'name_match' ? 0.75 : 0.7;

    // Boost if name mentioned in prompt
    if (mentionedNames.has(entity.name.toLowerCase())) {
      score += 0.20;
    }

    // Boost if type matches intent
    if (intentBoosts.includes(entity.type)) {
      score += 0.15;
    }

    // Penalty for non-active status
    if (entity.status !== 'active' && entity.status !== 'unknown') {
      score -= 0.30;
    }

    if (score >= 0.35) {
      const text = `**${entity.name}** (${entity.type})${entity.content ? `: ${entity.content}` : ''}`;
      items.push({ category: 'entity', score, text, id: entity.id });
    }
  }

  // Score lessons
  for (const lesson of context.lessons) {
    // Negative lessons are more urgent
    const outcomeMultiplier = lesson.outcome === 'negative' ? 1.2 : 1.0;
    const score = lesson.confidence * outcomeMultiplier;

    if (score >= 0.35) {
      const prefix = lesson.outcome === 'negative' ? 'Avoid' : 'Tip';
      const text = `${prefix}: "${lesson.trigger}" → ${lesson.action}`;
      items.push({ category: 'lesson', score, text, id: lesson.id });
    }
  }

  // Score issues
  const severityScores: Record<string, number> = {
    critical: 0.95, high: 0.8, medium: 0.6, low: 0.4,
  };
  for (const issue of context.openIssues) {
    const score = severityScores[issue.severity] ?? 0.5;
    const text = `[${issue.severity}] ${issue.title}`;
    items.push({ category: 'issue', score, text, id: issue.id });
  }

  // Score last session
  if (context.lastSession) {
    const s = context.lastSession;
    const text = `Last session goal: ${s.goal}${s.summary ? ` — ${s.summary}` : ''}`;
    items.push({ category: 'session', score: 0.65, text, id: 'last-session' });
  }

  // Score neighbors
  for (const neighbor of context.neighbors) {
    const text = `${neighbor.name} (${neighbor.type})`;
    items.push({ category: 'neighbor', score: 0.45, text, id: neighbor.id });
  }

  // Sort by score descending
  return items.sort((a, b) => b.score - a.score);
}
