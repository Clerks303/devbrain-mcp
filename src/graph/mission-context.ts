/**
 * Mission context generator — composes a structured markdown prompt for
 * executing a specific goal, bundling entities, conventions, lessons, vision,
 * and team suggestions.
 */
import type { KnowledgeStore } from '../db/store.js';
import type { VectorStore } from '../db/vector.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type {
  Entity,
  Goal,
  GoalEntityRole,
  Lesson,
  ProjectVision,
  Rule,
} from '../types.js';
import { getGoal, getGoalEntities, getProjectVision } from '../db/goals-store.js';

export type EstimatedComplexity = 'small' | 'medium' | 'large';

export interface MissionContextFile {
  entity_id: string;
  name: string;
  type: string;
  path: string | null;
  summary: string | null;
  role: GoalEntityRole;
}

export interface TeamSuggestion {
  coordinator: string;
  workers: string[];
}

export interface MissionContext {
  prompt: string;
  goal: Goal;
  vision: ProjectVision | null;
  files: MissionContextFile[];
  conventions: Rule[];
  lessons: Lesson[];
  team_suggestion: TeamSuggestion;
  estimated_complexity: EstimatedComplexity;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function entityFilePath(entity: Entity): string | null {
  // "file:path" entities encode their path in the name.
  if (entity.name.startsWith('file:')) {
    return entity.name.slice('file:'.length);
  }
  // metadata may carry a path hint
  const meta = entity.metadata;
  if (meta && typeof meta === 'object') {
    const p = (meta as Record<string, unknown>).path;
    if (typeof p === 'string') return p;
  }
  return null;
}

function detectLayers(entities: Array<Entity & { role: GoalEntityRole }>): Set<string> {
  const layers = new Set<string>();
  const hints: Record<string, string[]> = {
    frontend: ['ui/', 'components/', 'pages/', '.tsx', '.jsx', '.vue', '.svelte', 'web/', 'client/'],
    backend: ['server/', 'api/', 'routes/', 'controller', 'service', 'handler'],
    database: ['schema', 'migration', '.sql', 'db/', 'model', 'repository'],
    infra: ['docker', 'ci/', '.github/', 'deploy', 'terraform'],
    test: ['test/', 'spec/', '.test.', '.spec.'],
  };

  for (const e of entities) {
    const path = (entityFilePath(e) ?? '').toLowerCase();
    const name = e.name.toLowerCase();
    const type = e.type.toLowerCase();
    for (const [layer, keywords] of Object.entries(hints)) {
      if (keywords.some(k => path.includes(k) || name.includes(k) || type.includes(k))) {
        layers.add(layer);
      }
    }
  }
  return layers;
}

function suggestTeam(layers: Set<string>): TeamSuggestion {
  const workers: string[] = [];
  if (layers.has('frontend')) workers.push('frontend-dev');
  if (layers.has('backend')) workers.push('backend-dev');
  if (layers.has('database')) workers.push('db-architect');
  if (layers.has('infra')) workers.push('devops');
  if (layers.has('test')) workers.push('tester');

  // Default: at least a coder + reviewer
  if (workers.length === 0) {
    workers.push('coder');
  }
  if (!workers.includes('tester')) workers.push('tester');

  return {
    coordinator: workers.length > 2 ? 'orchestrator' : 'pair-programmer',
    workers,
  };
}

function estimateComplexity(fileCount: number, ruleCount: number): EstimatedComplexity {
  const score = fileCount + Math.floor(ruleCount / 3);
  if (score <= 3) return 'small';
  if (score <= 8) return 'medium';
  return 'large';
}

function formatStack(stack: ProjectVision['stack']): string {
  if (stack.length === 0) return '(no stack documented)';
  return stack.map(s => `- **${s.layer}**: ${s.tech}`).join('\n');
}

function formatRuleLine(rule: Rule): string {
  const tag = `[${rule.severity.toUpperCase()}]`;
  const scope = rule.scope !== 'global' && rule.pattern
    ? ` _(${rule.scope}: ${rule.pattern})_`
    : '';
  return `- ${tag}${scope} ${rule.content}`;
}

function formatLessonLine(lesson: Lesson): string {
  const conf = Math.round(lesson.confidence * 100);
  return `- When "${lesson.trigger}" → ${lesson.action} _(confidence: ${conf}%)_`;
}

function buildPrompt(params: {
  goal: Goal;
  vision: ProjectVision | null;
  files: MissionContextFile[];
  conventions: Rule[];
  lessons: Lesson[];
  complexity: EstimatedComplexity;
}): string {
  const { goal, vision, files, conventions, lessons, complexity } = params;
  const lines: string[] = [];

  lines.push(`# Mission: ${goal.title}`);
  lines.push('');

  // --- Contexte projet ---
  lines.push('## Contexte projet');
  if (vision?.description) {
    lines.push(vision.description);
  } else {
    lines.push('_No project vision documented. Run `devbrain_set_project_vision` to add one._');
  }
  if (vision && vision.stack.length > 0) {
    lines.push('');
    lines.push('**Stack:**');
    lines.push(formatStack(vision.stack));
  }
  lines.push('');

  // --- Objectif ---
  lines.push('## Objectif');
  lines.push(`- **Priorité:** ${goal.priority}`);
  lines.push(`- **Statut:** ${goal.status}`);
  if (goal.description) {
    lines.push('');
    lines.push(goal.description);
  }
  lines.push('');

  // --- Fichiers concernés ---
  lines.push('## Fichiers concernés');
  if (files.length === 0) {
    lines.push('_No entities linked to this goal yet._');
  } else {
    for (const f of files) {
      const pathPart = f.path ? ` \`${f.path}\`` : '';
      const summaryPart = f.summary ? ` — ${f.summary}` : '';
      lines.push(`- **${f.name}** (${f.type}, role: ${f.role})${pathPart}${summaryPart}`);
    }
  }
  lines.push('');

  // --- Conventions ---
  lines.push('## Conventions à respecter');
  if (conventions.length === 0) {
    lines.push('_No conventions documented for this project._');
  } else {
    // Sort: must → should → prefer
    const order: Record<string, number> = { must: 0, should: 1, prefer: 2 };
    const sorted = [...conventions].sort((a, b) =>
      (order[a.severity] ?? 3) - (order[b.severity] ?? 3),
    );
    for (const rule of sorted) {
      lines.push(formatRuleLine(rule));
    }
  }
  lines.push('');

  // --- Leçons passées ---
  lines.push('## Leçons passées');
  if (lessons.length === 0) {
    lines.push('_No relevant lessons found._');
  } else {
    for (const lesson of lessons) {
      lines.push(formatLessonLine(lesson));
    }
  }
  lines.push('');

  // --- Contraintes techniques ---
  lines.push('## Contraintes techniques');
  const constraints = vision?.constraints ?? [];
  if (constraints.length === 0 && (vision?.stack ?? []).length === 0) {
    lines.push('_No explicit technical constraints._');
  } else {
    for (const c of constraints) lines.push(`- ${c}`);
    if (vision && vision.stack.length > 0) {
      lines.push('- Use only the documented stack above; justify any deviation.');
    }
  }
  lines.push('');

  // --- Critères de succès ---
  lines.push('## Critères de succès');
  lines.push(`- Goal "${goal.title}" marked as \`done\` in DevBrain.`);
  if (complexity !== 'small') {
    lines.push('- All linked entities updated/observed with implementation notes.');
  }
  lines.push('- No regressions on existing conventions (must-rules).');
  lines.push('- Mission logged via `devbrain_record_goal_mission` with outcome.');

  return lines.join('\n');
}

export interface GenerateMissionContextParams {
  readonly goalId: string;
  readonly maxLessons?: number;
  readonly maxConventions?: number;
}

export async function generateMissionContext(
  store: KnowledgeStore,
  vectorStore: VectorStore,
  embeddingProvider: EmbeddingProvider,
  params: GenerateMissionContextParams,
): Promise<MissionContext> {
  const db = store.getDb();
  const goal = getGoal(db, params.goalId);
  if (!goal) throw new Error(`Goal not found: ${params.goalId}`);

  const vision = getProjectVision(db, goal.projectId);

  // --- Linked entities → file descriptors ---
  const linkedEntities = getGoalEntities(db, goal.id);
  const files: MissionContextFile[] = linkedEntities.map(e => {
    const path = entityFilePath(e);
    let summary: string | null = e.content;
    if (path) {
      const digest = store.getFileDigestByPath(goal.projectId, path);
      if (digest?.summary) summary = digest.summary;
    }
    return {
      entity_id: e.id,
      name: e.name,
      type: e.type,
      path,
      summary,
      role: e.role,
    };
  });

  // --- Conventions: context-matched + semantic ---
  const maxConventions = params.maxConventions ?? 10;
  let conventions: Rule[] = [];
  try {
    const matched = store.matchRules(goal.projectId, {});
    conventions.push(...matched);
  } catch { /* ignore */ }

  // Semantic rule search by goal title + description
  const searchText = [goal.title, goal.description].filter(Boolean).join(' — ');
  try {
    const embedding = await embeddingProvider.embed(searchText);
    const results = vectorStore.searchRules(embedding, 5);
    for (const r of results) {
      const rule = store.getRule(r.id);
      if (rule && rule.projectId === goal.projectId) {
        conventions.push(rule);
      }
    }
  } catch { /* embedding/vec errors are non-fatal */ }

  conventions = uniqueById(conventions).slice(0, maxConventions);

  // --- Lessons ---
  const maxLessons = params.maxLessons ?? 5;
  let lessons: Lesson[] = [];
  try {
    const embedding = await embeddingProvider.embed(searchText);
    const results = vectorStore.searchLessons(embedding, maxLessons);
    for (const r of results) {
      const lesson = store.getLesson(r.id);
      if (lesson && lesson.projectId === goal.projectId) {
        lessons.push(lesson);
      }
    }
  } catch { /* ignore */ }
  lessons = uniqueById(lessons).slice(0, maxLessons);

  // --- Complexity + Team suggestion ---
  const complexity = estimateComplexity(files.length, conventions.length);
  const layers = detectLayers(linkedEntities);
  const team = suggestTeam(layers);

  const prompt = buildPrompt({ goal, vision, files, conventions, lessons, complexity });

  return {
    prompt,
    goal,
    vision,
    files,
    conventions,
    lessons,
    team_suggestion: team,
    estimated_complexity: complexity,
  };
}
