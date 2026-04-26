import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerRelationTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_add_relation',
    'Create a relation between two entities in the knowledge graph',
    {
      from_entity_id: z.string().describe('Source entity ID'),
      to_entity_id: z.string().describe('Target entity ID'),
      type: z.string().describe('Relation type: imports, calls, depends_on, implements, decided_because, related_to, supersedes'),
      weight: z.number().min(0).max(1).optional().describe('Relation weight/strength (0-1, default 1.0)'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ from_entity_id, to_entity_id, type, weight, metadata }) => {
      // Validate entities exist
      const fromEntity = brain.store.getEntity(from_entity_id);
      if (!fromEntity) {
        return { content: [{ type: 'text' as const, text: `Source entity not found: ${from_entity_id}` }], isError: true };
      }
      const toEntity = brain.store.getEntity(to_entity_id);
      if (!toEntity) {
        return { content: [{ type: 'text' as const, text: `Target entity not found: ${to_entity_id}` }], isError: true };
      }

      const relation = brain.store.addRelation({
        fromEntityId: from_entity_id,
        toEntityId: to_entity_id,
        type,
        weight,
        metadata: metadata ?? null,
      });

      if (brain.activeSessionId) {
        brain.store.updateSessionCounters(brain.activeSessionId, { entitiesModified: 1 });
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Created relation: "${fromEntity.name}" --[${type}]--> "${toEntity.name}"\n${JSON.stringify(relation, null, 2)}`,
        }],
      };
    },
  );

  server.tool(
    'devbrain_delete_relation',
    'Delete a relation from the knowledge graph',
    {
      id: z.string().describe('Relation ID to delete'),
    },
    async ({ id }) => {
      const relation = brain.store.getRelation(id);
      if (!relation) {
        return { content: [{ type: 'text' as const, text: `Relation not found: ${id}` }], isError: true };
      }

      brain.store.deleteRelation(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted relation ${id}.` }],
      };
    },
  );
}
