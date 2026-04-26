import type { KnowledgeStore } from '../db/store.js';
import type { VectorStore } from '../db/vector.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { HybridSearchResult, Rule, Lesson, Issue, Session } from '../types.js';
import { hybridSearch } from './search.js';

export interface AutoContextParams {
  query: string;
  filePath?: string;
  entityType?: string;
  includeRules?: boolean;
  includeLessons?: boolean;
  includeIssues?: boolean;
  limit?: number;
}

export interface AutoContextResult {
  entities: HybridSearchResult[];
  rules: Rule[];
  lessons: Lesson[];
  openIssues: Issue[];
  lastSession: Session | null;
}

export async function getAutoContext(
  store: KnowledgeStore,
  vectorStore: VectorStore,
  embeddingProvider: EmbeddingProvider,
  projectId: string,
  params: AutoContextParams,
): Promise<AutoContextResult> {
  const limit = params.limit ?? 5;
  const includeRules = params.includeRules !== false;
  const includeLessons = params.includeLessons !== false;
  const includeIssues = params.includeIssues !== false;

  // 1. Hybrid search for entities
  let entities: HybridSearchResult[] = [];
  try {
    entities = await hybridSearch(store, vectorStore, embeddingProvider, params.query, {
      projectId,
      limit,
    });
  } catch { /* ignore */ }

  // Generate embedding for semantic searches
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embeddingProvider.embed(params.query);
  } catch { /* ignore */ }

  // 2. Rules
  let rules: Rule[] = [];
  if (includeRules) {
    try {
      // Get matching rules by context
      const matchedRules = store.matchRules(projectId, {
        filePath: params.filePath,
        entityType: params.entityType,
      });
      rules.push(...matchedRules);

      // Also search semantically
      if (queryEmbedding) {
        const semanticRuleResults = vectorStore.searchRules(queryEmbedding, 3);
        for (const r of semanticRuleResults) {
          const rule = store.getRule(r.id);
          if (rule && rule.projectId === projectId && !rules.some(existing => existing.id === rule.id)) {
            rules.push(rule);
          }
        }
      }
    } catch { /* ignore — tables may not exist yet */ }
  }

  // 3. Lessons
  let lessons: Lesson[] = [];
  if (includeLessons && queryEmbedding) {
    try {
      const lessonResults = vectorStore.searchLessons(queryEmbedding, 3);
      for (const r of lessonResults) {
        const lesson = store.getLesson(r.id);
        if (lesson && lesson.projectId === projectId) {
          lessons.push(lesson);
        }
      }
    } catch { /* ignore */ }
  }

  // 4. Open issues
  let openIssues: Issue[] = [];
  if (includeIssues) {
    try {
      openIssues = store.listIssues(projectId, { status: 'open' }).slice(0, 5);
    } catch { /* ignore */ }
  }

  // 5. Last session
  let lastSession: Session | null = null;
  try {
    lastSession = store.getLastSession(projectId);
  } catch { /* ignore */ }

  return { entities, rules, lessons, openIssues, lastSession };
}
