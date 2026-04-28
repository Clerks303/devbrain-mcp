import type { KnowledgeStore } from '../db/store.js';
import type { VectorStore } from '../db/vector.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { HybridSearchResult } from '../types.js';

// Reciprocal Rank Fusion constant. k=60 is the canonical value from the
// original RRF paper (Cormack et al. 2009). Higher k flattens contributions
// from low-ranked items; lower k makes top ranks dominate.
const RRF_K = 60;

// Per-source weights. These are deliberately gentler than the previous
// hand-tuned cosine-distance multipliers because RRF already discounts
// lower ranks naturally — the weights only express *source trust*.
const RRF_WEIGHTS = {
  entityVector: 1.0,
  observationVector: 0.7,
  issueVector: 0.6,
  nameMatch: 0.9,
} as const;

type Source = keyof typeof RRF_WEIGHTS;

interface Accumulator {
  rrf: number;
  sources: Set<Source>;
}

function addRanked(
  acc: Map<string, Accumulator>,
  entityId: string,
  rank: number, // 0-indexed
  source: Source,
): void {
  const contribution = RRF_WEIGHTS[source] / (RRF_K + rank + 1);
  const existing = acc.get(entityId);
  if (existing) {
    existing.rrf += contribution;
    existing.sources.add(source);
  } else {
    acc.set(entityId, { rrf: contribution, sources: new Set([source]) });
  }
}

function classify(sources: Set<Source>): 'vector' | 'graph' | 'both' {
  const hasVector =
    sources.has('entityVector') ||
    sources.has('observationVector') ||
    sources.has('issueVector');
  const hasGraph = sources.has('nameMatch');
  if (hasVector && hasGraph) return 'both';
  if (hasVector) return 'vector';
  return 'graph';
}

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
  const acc = new Map<string, Accumulator>();

  // Vector search — skip entirely when no embedding provider is configured
  // (NoOp returns []); RRF then degrades to a single-source name-match ranker.
  const queryEmbedding = await embeddingProvider.embed(query);
  const hasVector = queryEmbedding.length > 0;

  if (hasVector) {
    const entityResults = vectorStore.searchEntities(queryEmbedding, limit * 2);
    entityResults.forEach((r, rank) => addRanked(acc, r.id, rank, 'entityVector'));

    const obsResults = vectorStore.searchObservations(queryEmbedding, limit);
    obsResults.forEach((r, rank) => {
      const obs = store.getObservation(r.id);
      if (obs) addRanked(acc, obs.entityId, rank, 'observationVector');
    });

    try {
      const issueResults = vectorStore.searchIssues(queryEmbedding, limit);
      issueResults.forEach((r, rank) => {
        try {
          const issue = store.getIssue(r.id);
          if (issue?.entityId) addRanked(acc, issue.entityId, rank, 'issueVector');
        } catch {
          // issue may have been deleted
        }
      });
    } catch {
      // issue_embeddings table may not exist yet
    }
  }

  // Name match — treated as its own ranked source. Order is the order
  // returned by the store (typically id/created_at); good enough for RRF.
  const nameMatches = store.findEntitiesByName(query, options.projectId);
  nameMatches.forEach((entity, rank) => addRanked(acc, entity.id, rank, 'nameMatch'));

  const results: HybridSearchResult[] = [];
  for (const [entityId, { rrf, sources }] of acc) {
    const entity = store.getEntity(entityId);
    if (!entity) continue;

    if (options.projectId && entity.projectId && entity.projectId !== options.projectId) {
      continue;
    }
    if (options.types && options.types.length > 0 && !options.types.includes(entity.type)) {
      continue;
    }

    const observations = store.getObservations(entityId);
    results.push({
      entity,
      score: rrf,
      matchType: classify(sources),
      observations,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
