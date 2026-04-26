import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { hybridSearch } from '../graph/search.js';
import { traverse } from '../graph/traversal.js';
import { getEntityContext } from '../graph/context.js';

export function registerSearchTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_search',
    'Semantic search across the knowledge graph using vector similarity',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().min(1).max(50).optional().describe('Max number of results (default 10)'),
      types: z.array(z.string()).optional().describe('Filter by entity types'),
    },
    async ({ query, limit, types }) => {
      const results = await hybridSearch(
        brain.store,
        brain.vectorStore,
        brain.embeddingProvider,
        query,
        {
          projectId: brain.activeProjectId,
          limit: limit ?? 10,
          types,
        },
      );

      const formatted = results.map(r => ({
        entity: { id: r.entity.id, name: r.entity.name, type: r.entity.type, content: r.entity.content, status: r.entity.status },
        score: Math.round(r.score * 1000) / 1000,
        matchType: r.matchType,
        observations: r.observations.map(o => o.content),
      }));

      return {
        content: [{
          type: 'text' as const,
          text: results.length > 0
            ? JSON.stringify(formatted, null, 2)
            : 'No results found.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_get_context',
    'Get the complete context of an entity (entity + relations + observations)',
    {
      entity_id: z.string().describe('Entity ID to get context for'),
    },
    async ({ entity_id }) => {
      const context = getEntityContext(brain.store, entity_id);
      if (!context) {
        return { content: [{ type: 'text' as const, text: `Entity not found: ${entity_id}` }], isError: true };
      }

      const formatted = {
        entity: context.entity,
        relations: {
          outgoing: context.relations.outgoing.map(r => ({
            type: r.type,
            weight: r.weight,
            target: { id: r.targetEntity.id, name: r.targetEntity.name, type: r.targetEntity.type },
          })),
          incoming: context.relations.incoming.map(r => ({
            type: r.type,
            weight: r.weight,
            source: { id: r.sourceEntity.id, name: r.sourceEntity.name, type: r.sourceEntity.type },
          })),
        },
        observations: context.observations,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_traverse',
    'Traverse the knowledge graph from an entity using BFS or DFS',
    {
      entity_id: z.string().describe('Starting entity ID'),
      max_depth: z.number().min(1).max(10).optional().describe('Maximum traversal depth (default 2)'),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().describe('Traversal direction (default both)'),
      relation_types: z.array(z.string()).optional().describe('Filter by relation types'),
      algorithm: z.enum(['bfs', 'dfs']).optional().describe('Traversal algorithm (default bfs)'),
    },
    async ({ entity_id, max_depth, direction, relation_types, algorithm }) => {
      const results = traverse(brain.store, entity_id, {
        maxDepth: max_depth ?? 2,
        direction: direction ?? 'both',
        relationTypes: relation_types,
        algorithm: algorithm ?? 'bfs',
      });

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `Entity not found: ${entity_id}` }], isError: true };
      }

      const formatted = results.map(n => ({
        entity: { id: n.entity.id, name: n.entity.name, type: n.entity.type, status: n.entity.status },
        depth: n.depth,
        path: n.path,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
      };
    },
  );
}
