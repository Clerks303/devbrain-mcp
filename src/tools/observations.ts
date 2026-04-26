import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerObservationTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_add_observation',
    'Add an observation (fact/note) about an entity',
    {
      entity_id: z.string().describe('Entity ID to attach the observation to'),
      content: z.string().describe('The observation content'),
      source: z.string().optional().describe('Source of the observation: user, agent, git, auto'),
      category: z.enum(['note', 'implementation', 'caveat', 'todo']).optional().describe('Observation category (default: note)'),
    },
    async ({ entity_id, content, source, category }) => {
      const entity = brain.store.getEntity(entity_id);
      if (!entity) {
        return { content: [{ type: 'text' as const, text: `Entity not found: ${entity_id}` }], isError: true };
      }

      const observation = brain.store.addObservation({
        entityId: entity_id,
        content,
        source: source ?? null,
        category,
      });

      // Generate and store embedding for the observation
      try {
        const embedding = await brain.embeddingProvider.embed(content);
        brain.vectorStore.upsertObservationEmbedding(observation.id, embedding);
      } catch (e) {
        console.error('Failed to generate observation embedding:', e);
      }

      if (brain.activeSessionId) {
        brain.store.updateSessionCounters(brain.activeSessionId, { entitiesModified: 1 });
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Added observation to "${entity.name}":\n${JSON.stringify(observation, null, 2)}`,
        }],
      };
    },
  );

  server.tool(
    'devbrain_delete_observation',
    'Delete an observation',
    {
      id: z.string().describe('Observation ID to delete'),
    },
    async ({ id }) => {
      const obs = brain.store.getObservation(id);
      if (!obs) {
        return { content: [{ type: 'text' as const, text: `Observation not found: ${id}` }], isError: true };
      }

      brain.vectorStore.deleteObservationEmbedding(id);
      brain.store.deleteObservation(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted observation ${id}.` }],
      };
    },
  );
}
