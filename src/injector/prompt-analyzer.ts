import type { PromptAnalysis, PromptIntent } from './types.js';

/** Intent detection patterns (FR + EN) */
const INTENT_PATTERNS: ReadonlyArray<{ intent: PromptIntent; patterns: RegExp }> = [
  {
    intent: 'implement',
    patterns: /\b(implémente|implemente|crée|créer|ajoute|ajouter|build|create|add|implement|write|code|develop|make)\b/i,
  },
  {
    intent: 'refactor',
    patterns: /\b(refactor[e]?|réorganis|migre|migrer|restructure|clean|simplif|déplace|rename|reorgani|extract|split)\b/i,
  },
  {
    intent: 'debug',
    patterns: /\b(bug|erreur|error|corrige|corriger|fix|broken|ne fonctionne|doesn'?t work|crash|fail|issue|problème|problem)\b/i,
  },
  {
    intent: 'review',
    patterns: /\b(reli[st]|vérifie|vérifier|audit|regarde|check|review|inspect|examine|analyse|analyze)\b/i,
  },
  {
    intent: 'architecture',
    patterns: /\b(conçois|concevoir|architect|design|structure|plan|schema|diagramm|système|system design)\b/i,
  },
];

/** File path extraction */
const FILE_PATTERN = /(?:(?:src|tests?|lib|dist|bin|scripts|config)\/[\w.\/\-]+\.\w{1,6})|(?:[\w\-]+\.(?:ts|js|tsx|jsx|json|yaml|yml|py|rs|go|sql|css|html|md))\b/gi;

/** Identifier extraction (PascalCase + camelCase) */
const IDENTIFIER_PATTERN = /\b([A-Z][a-zA-Z0-9]{2,}|[a-z][a-zA-Z0-9]{2,}[A-Z][a-zA-Z0-9]*)\b/g;

/** Identifiers to ignore (language/tool names, not project entities) */
const IDENTIFIER_STOP_LIST = new Set([
  'Claude', 'TypeScript', 'JavaScript', 'Python', 'React', 'NextJs', 'NodeJs',
  'DevBrain', 'GitHub', 'Docker', 'Redis', 'PostgreSQL', 'MongoDB', 'Express',
  'Fastify', 'Vitest', 'String', 'Number', 'Boolean', 'Object', 'Array',
  'Promise', 'Error', 'Function', 'Console', 'Buffer', 'JSON', 'Date',
]);

/** French stop words to exclude from keywords */
const STOP_WORDS = new Set([
  // FR
  'dans', 'pour', 'avec', 'sans', 'sur', 'sous', 'entre', 'vers', 'chez',
  'mais', 'donc', 'puis', 'aussi', 'comme', 'quand', 'tout', 'tous', 'cette',
  'quel', 'elle', 'nous', 'vous', 'leur', 'autre', 'même', 'faire',
  // EN
  'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would', 'could',
  'should', 'about', 'into', 'when', 'what', 'where', 'which', 'their',
  'there', 'other', 'some', 'than', 'then', 'them', 'only', 'just',
  'also', 'more', 'very', 'much', 'make', 'like', 'want', 'need',
]);

/** Trivial prompts that should not trigger injection */
const TRIVIAL_PATTERNS = /^(ok|oui|yes|non|no|go|continue|d'accord|bien|merci|thanks|sure|yep|nope|y|n|\.{1,3})\s*[.!?]*$/i;

/** Language detection heuristics */
const FR_MARKERS = /\b(est|les|des|une|que|pas|avec|dans|pour|sur|qui|sont|fait|cette|vous)\b/gi;
const EN_MARKERS = /\b(the|is|are|was|were|have|has|had|will|would|can|could|should|this|that|with)\b/gi;

export function analyzePrompt(rawPrompt: string): PromptAnalysis {
  const trimmed = rawPrompt.trim();

  // Trivial prompt detection
  if (trimmed.length < 10 || TRIVIAL_PATTERNS.test(trimmed)) {
    return {
      rawPrompt: trimmed,
      intent: 'generic',
      mentionedFiles: [],
      mentionedIdentifiers: [],
      keywords: [],
      language: detectLanguage(trimmed),
      confidence: 0.1,
    };
  }

  // Intent detection
  const intent = detectIntent(trimmed);

  // File paths
  const mentionedFiles = [...new Set(
    [...trimmed.matchAll(FILE_PATTERN)].map(m => m[0])
  )];

  // Identifiers (PascalCase + camelCase)
  const mentionedIdentifiers = [...new Set(
    [...trimmed.matchAll(IDENTIFIER_PATTERN)]
      .map(m => m[1])
      .filter(id => !IDENTIFIER_STOP_LIST.has(id))
  )];

  // Keywords (words >= 4 chars, not stop words)
  const keywords = [...new Set(
    trimmed
      .replace(/[^\w\sàâéèêëïîôùûüÿçœæ]/g, ' ')
      .split(/\s+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  )].slice(0, 8);

  // Language
  const language = detectLanguage(trimmed);

  // Confidence based on signal richness
  const signalCount = mentionedFiles.length + mentionedIdentifiers.length + keywords.length;
  const confidence = Math.min(1, 0.4 + signalCount * 0.1);

  return {
    rawPrompt: trimmed,
    intent,
    mentionedFiles,
    mentionedIdentifiers,
    keywords,
    language,
    confidence,
  };
}

function detectIntent(text: string): PromptIntent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.test(text)) return intent;
  }
  return 'generic';
}

function detectLanguage(text: string): 'fr' | 'en' | 'mixed' {
  const frCount = (text.match(FR_MARKERS) ?? []).length;
  const enCount = (text.match(EN_MARKERS) ?? []).length;
  if (frCount === 0 && enCount === 0) return 'en'; // default
  if (frCount > enCount * 2) return 'fr';
  if (enCount > frCount * 2) return 'en';
  return 'mixed';
}
