import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerEntityTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_add_entity',
    'Add an entity to the knowledge graph (function, class, decision, pattern, etc.)',
    {
      name: z.string().describe('Entity name'),
      type: z.string().describe('Entity type: function, class, module, decision, pattern, convention, dependency, or custom'),
      content: z.string().optional().describe('Description or content of the entity'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata as key-value pairs'),
      status: z.enum(['active', 'deprecated', 'experimental', 'stable', 'unknown']).optional().describe('Entity status'),
    },
    async ({ name, type, content, metadata, status }) => {
      const entity = brain.store.addEntity({
        name,
        type,
        projectId: brain.activeProjectId,
        content: content ?? null,
        metadata: metadata ?? null,
        status,
      });

      // Generate and store embedding
      if (content || name) {
        const text = [name, content].filter(Boolean).join(': ');
        try {
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertEntityEmbedding(entity.id, embedding);
        } catch (e) {
          console.error('Failed to generate embedding:', e);
        }
      }

      if (brain.activeSessionId) {
        brain.store.updateSessionCounters(brain.activeSessionId, { entitiesModified: 1 });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entity, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_update_entity',
    'Update an existing entity in the knowledge graph',
    {
      id: z.string().describe('Entity ID to update'),
      name: z.string().optional().describe('New name'),
      type: z.string().optional().describe('New type'),
      content: z.string().optional().describe('New content/description'),
      metadata: z.record(z.unknown()).optional().describe('New metadata (replaces existing)'),
      status: z.enum(['active', 'deprecated', 'experimental', 'stable', 'unknown']).optional().describe('Entity status'),
    },
    async ({ id, name, type, content, metadata, status }) => {
      const entity = brain.store.updateEntity(id, {
        name,
        type,
        content,
        metadata,
        status,
      });

      // Re-generate embedding if content changed
      if (name || content) {
        const text = [entity.name, entity.content].filter(Boolean).join(': ');
        try {
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertEntityEmbedding(entity.id, embedding);
        } catch (e) {
          console.error('Failed to generate embedding:', e);
        }
      }

      if (brain.activeSessionId) {
        brain.store.updateSessionCounters(brain.activeSessionId, { entitiesModified: 1 });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entity, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_delete_entity',
    'Delete an entity and all its relations/observations from the knowledge graph',
    {
      id: z.string().describe('Entity ID to delete'),
    },
    async ({ id }) => {
      const entity = brain.store.getEntity(id);
      if (!entity) {
        return { content: [{ type: 'text' as const, text: `Entity not found: ${id}` }], isError: true };
      }

      brain.vectorStore.deleteEntityEmbedding(id);
      // Delete observation embeddings too
      const observations = brain.store.getObservations(id);
      for (const obs of observations) {
        brain.vectorStore.deleteObservationEmbedding(obs.id);
      }

      brain.store.deleteEntity(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted entity "${entity.name}" and its relations/observations.` }],
      };
    },
  );
}
