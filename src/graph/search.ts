import type { KnowledgeStore } from '../db/store.js';
import type { VectorStore } from '../db/vector.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { HybridSearchResult } from '../types.js';

export async function hybridSearch(
  store: KnowledgeStore,
  vectorStore: VectorStore,
  embeddingProvider: EmbeddingProvider,
  query: string,
  options: {
    projectId?: string | null;
    limit?: number;
    types?: string[];
  } = {},
): Promise<HybridSearchResult[]> {
  const limit = options.limit ?? 10;
  const resultMap = new Map<string, { score: number; matchType: 'vector' | 'graph' | 'both' }>();

  // 1. Vector search on entities
  const queryEmbedding = await embeddingProvider.embed(query);
  const entityResults = vectorStore.searchEntities(queryEmbedding, limit * 2);

  for (const result of entityResults) {
    // Cosine distance: lower = more similar. Convert to score (0-1, higher = better)
    const score = 1 - result.distance;
    resultMap.set(result.id, { score, matchType: 'vector' });
  }

  // 2. Vector search on observations to find related entities
  const obsResults = vectorStore.searchObservations(queryEmbedding, limit);
  for (const result of obsResults) {
    const obs = store.getObservation(result.id);
    if (!obs) continue;
    const entityId = obs.entityId;
    const score = (1 - result.distance) * 0.8; // Slightly lower weight for observation matches
    const existing = resultMap.get(entityId);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.matchType = 'both';
    } else {
      resultMap.set(entityId, { score, matchType: 'graph' });
    }
  }

  // TODO: File digest search could be used to boost entities linked to matching files
  // via the linking system (file:path entities + defined_in relations).
  // Currently skipped because file digest IDs don't map directly to entity IDs.

  // 2b. Vector search on issues to find related entities
  try {
    const issueResults = vectorStore.searchIssues(queryEmbedding, limit);
    for (const result of issueResults) {
      // Try to get the issue to find its entityId
      try {
        const issue = store.getIssue(result.id);
        if (issue?.entityId) {
          const score = (1 - result.distance) * 0.7;
          const existing = resultMap.get(issue.entityId);
          if (existing) {
            existing.score = Math.max(existing.score, score);
            existing.matchType = 'both';
          } else {
            resultMap.set(issue.entityId, { score, matchType: 'graph' });
          }
        }
      } catch {
        // issue may have been deleted
      }
    }
  } catch {
    // issue_embeddings table may not exist yet
  }

  // 3. Text search fallback (name matching)
  const nameMatches = store.findEntitiesByName(query, options.projectId);
  for (const entity of nameMatches) {
    const existing = resultMap.get(entity.id);
    if (existing) {
      existing.score += 0.3; // Boost for name match
      existing.matchType = 'both';
    } else {
      resultMap.set(entity.id, { score: 0.5, matchType: 'graph' });
    }
  }

  // 4. Build results
  const results: HybridSearchResult[] = [];
  for (const [entityId, { score, matchType }] of resultMap) {
    const entity = store.getEntity(entityId);
    if (!entity) continue;

    // Filter by project
    if (options.projectId && entity.projectId && entity.projectId !== options.projectId) {
      continue;
    }

    // Filter by type
    if (options.types && options.types.length > 0 && !options.types.includes(entity.type)) {
      continue;
    }

    const observations = store.getObservations(entityId);
    results.push({ entity, score, matchType, observations });
  }

  // Sort by score descending, take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
