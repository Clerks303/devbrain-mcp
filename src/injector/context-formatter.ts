import type { TokenBudgetAllocation, ScoredItem } from './types.js';
import type { PromptAnalysis } from './types.js';

/** Labels for each section, keyed by language */
const SECTION_LABELS: Record<string, Record<string, string>> = {
  fr: {
    rules: 'Conventions obligatoires pour ce projet',
    session: 'Contexte de session précédente',
    entities: 'Éléments du projet pertinents',
    lessons: 'Leçons apprises',
    issues: 'Issues ouvertes',
    neighbors: 'Modules liés',
  },
  en: {
    rules: 'Mandatory project conventions',
    session: 'Previous session context',
    entities: 'Relevant project elements',
    lessons: 'Learned lessons',
    issues: 'Open issues',
    neighbors: 'Related modules',
  },
};

function getLabels(language: string): Record<string, string> {
  return SECTION_LABELS[language] ?? SECTION_LABELS.en;
}

/** Format a list of scored items as markdown bullet points */
function formatBullets(items: readonly ScoredItem[]): string {
  return items.map(item => `- ${item.text}`).join('\n');
}

/**
 * Format the allocated budget into natural markdown context.
 * Sections with no items are omitted entirely.
 */
export function formatContext(
  allocation: TokenBudgetAllocation,
  analysis: PromptAnalysis,
): string {
  const lang = analysis.language === 'fr' ? 'fr' : 'en';
  const labels = getLabels(lang);
  const sections: string[] = [];

  // Header comment
  sections.push(`<!-- DevBrain context for: ${analysis.intent} -->`);

  // Rules
  if (allocation.rules.length > 0) {
    sections.push(`**${labels.rules} :**\n${formatBullets(allocation.rules)}`);
  }

  // Previous session
  if (allocation.session.length > 0) {
    sections.push(`**${labels.session} :** ${allocation.session[0].text}`);
  }

  // Entities
  if (allocation.entities.length > 0) {
    sections.push(`**${labels.entities} :**\n${formatBullets(allocation.entities)}`);
  }

  // Lessons
  if (allocation.lessons.length > 0) {
    sections.push(`**${labels.lessons} :**\n${formatBullets(allocation.lessons)}`);
  }

  // Issues
  if (allocation.issues.length > 0) {
    sections.push(`**${labels.issues} :**\n${formatBullets(allocation.issues)}`);
  }

  // Neighbors
  if (allocation.neighbors.length > 0) {
    sections.push(`**${labels.neighbors} :** ${allocation.neighbors.map(n => n.text).join(', ')}`);
  }

  // If no sections besides the header, return empty
  if (sections.length <= 1) return '';

  return sections.join('\n\n');
}

/**
 * Generate the permanent rules file content for session start.
 * This file is written to ~/.claude/rules/devbrain-project-context.md
 * and loaded automatically as system instructions by Claude Code.
 */
export function formatRulesFile(
  projectName: string,
  rules: readonly ScoredItem[],
  topEntities: readonly ScoredItem[],
  lastSession: readonly ScoredItem[],
): string {
  const sections: string[] = [];

  sections.push(`# DevBrain — ${projectName}`);
  sections.push('> Auto-generated project context. Do not edit manually.');

  if (rules.length > 0) {
    sections.push(`## Mandatory conventions\n${formatBullets(rules)}`);
  }

  if (topEntities.length > 0) {
    sections.push(`## Key architecture elements\n${formatBullets(topEntities)}`);
  }

  if (lastSession.length > 0) {
    sections.push(`## Last session\n${lastSession[0].text}`);
  }

  return sections.join('\n\n') + '\n';
}
