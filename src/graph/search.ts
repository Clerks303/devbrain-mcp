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

    // Batch-resolve observation→entity in one query instead of N getObservation calls.
    const obsResults = vectorStore.searchObservations(queryEmbedding, limit);
    if (obsResults.length > 0) {
      const obsToEntity = store.getObservationEntityIds(obsResults.map(r => r.id));
      obsResults.forEach((r, rank) => {
        const eId = obsToEntity.get(r.id);
        if (eId) addRanked(acc, eId, rank, 'observationVector');
      });
    }

    try {
      const issueResults = vectorStore.searchIssues(queryEmbedding, limit);
      if (issueResults.length > 0) {
        const issueToEntity = store.getIssueEntityIds(issueResults.map(r => r.id));
        issueResults.forEach((r, rank) => {
          const eId = issueToEntity.get(r.id);
          if (eId) addRanked(acc, eId, rank, 'issueVector');
        });
      }
    } catch {
      // issue_embeddings table may not exist yet
    }
  }

  // Name match — treated as its own ranked source. Order is the order
  // returned by the store (typically id/created_at); good enough for RRF.
  const nameMatches = store.findEntitiesByName(query, options.projectId);
  nameMatches.forEach((entity, rank) => addRanked(acc, entity.id, rank, 'nameMatch'));

  if (acc.size === 0) return [];

  // Batch-fetch entities (with project/type filtering at the SQL layer) and
  // their observations in two queries instead of 2*N.
  const entityIds = [...acc.keys()];
  const entities = store.getEntitiesByIds(entityIds, {
    projectId: options.projectId,
    types: options.types,
  });
  const obsByEntity = store.getObservationsGroupedByEntityIds(entities.map(e => e.id));

  const results: HybridSearchResult[] = entities.map((entity) => {
    const accEntry = acc.get(entity.id)!;
    return {
      entity,
      score: accEntry.rrf,
      matchType: classify(accEntry.sources),
      observations: obsByEntity.get(entity.id) ?? [],
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
