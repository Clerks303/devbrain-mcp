import type { KnowledgeStore } from '../db/store.js';
import type { TraversalNode } from '../types.js';

export interface TraversalOptions {
  maxDepth: number;
  direction: 'outgoing' | 'incoming' | 'both';
  relationTypes?: string[];
  algorithm: 'bfs' | 'dfs';
}

const defaultOptions: TraversalOptions = {
  maxDepth: 2,
  direction: 'both',
  algorithm: 'bfs',
};

export function traverse(
  store: KnowledgeStore,
  startEntityId: string,
  options: Partial<TraversalOptions> = {},
): TraversalNode[] {
  const opts = { ...defaultOptions, ...options };
  const visited = new Set<string>();
  const results: TraversalNode[] = [];

  const startEntity = store.getEntity(startEntityId);
  if (!startEntity) return results;

  if (opts.algorithm === 'bfs') {
    bfs(store, startEntityId, opts, visited, results);
  } else {
    dfs(store, startEntityId, 0, [], opts, visited, results);
  }

  return results;
}

function getNeighbors(
  store: KnowledgeStore,
  entityId: string,
  opts: TraversalOptions,
): { entityId: string; relation: ReturnType<KnowledgeStore['getRelations']>[number] }[] {
  const direction = opts.direction === 'outgoing' ? 'from'
    : opts.direction === 'incoming' ? 'to'
    : 'both';

  const relations = store.getRelations(entityId, direction);
  const filtered = opts.relationTypes
    ? relations.filter(r => opts.relationTypes!.includes(r.type))
    : relations;

  return filtered.map(r => ({
    entityId: r.fromEntityId === entityId ? r.toEntityId : r.fromEntityId,
    relation: r,
  }));
}

function bfs(
  store: KnowledgeStore,
  startId: string,
  opts: TraversalOptions,
  visited: Set<string>,
  results: TraversalNode[],
): void {
  const queue: { id: string; depth: number; path: string[]; relations: ReturnType<KnowledgeStore['getRelations']> }[] = [
    { id: startId, depth: 0, path: [startId], relations: [] },
  ];
  visited.add(startId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entity = store.getEntity(current.id);
    if (!entity) continue;

    results.push({
      entity,
      depth: current.depth,
      path: current.path,
      relations: current.relations,
    });

    if (current.depth >= opts.maxDepth) continue;

    for (const neighbor of getNeighbors(store, current.id, opts)) {
      if (!visited.has(neighbor.entityId)) {
        visited.add(neighbor.entityId);
        queue.push({
          id: neighbor.entityId,
          depth: current.depth + 1,
          path: [...current.path, neighbor.entityId],
          relations: [...current.relations, neighbor.relation],
        });
      }
    }
  }
}

function dfs(
  store: KnowledgeStore,
  entityId: string,
  depth: number,
  path: string[],
  opts: TraversalOptions,
  visited: Set<string>,
  results: TraversalNode[],
): void {
  visited.add(entityId);
  const entity = store.getEntity(entityId);
  if (!entity) return;

  const currentPath = [...path, entityId];
  results.push({
    entity,
    depth,
    path: currentPath,
    relations: [],
  });

  if (depth >= opts.maxDepth) return;

  for (const neighbor of getNeighbors(store, entityId, opts)) {
    if (!visited.has(neighbor.entityId)) {
      dfs(store, neighbor.entityId, depth + 1, currentPath, opts, visited, results);
    }
  }
}
