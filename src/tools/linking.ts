import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerLinkingTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_link_files',
    'Link files to entities in the knowledge graph. Creates "file:path" entities if needed and relations between them.',
    {
      links: z.array(z.object({
        file_path: z.string().describe('File path (must exist as a file digest)'),
        entity_name_or_id: z.string().describe('Entity name or ID to link to'),
        relation_type: z.string().optional().describe('Relation type (default: defined_in)'),
      })).describe('Array of file-entity links to create'),
    },
    async ({ links }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      let created = 0;
      const errors: string[] = [];

      for (const link of links) {
        // Find file digest
        const fileDigest = brain.store.getFileDigestByPath(brain.activeProjectId, link.file_path);
        if (!fileDigest) {
          errors.push(`File digest not found: ${link.file_path}`);
          continue;
        }

        // Find or create "file:path" entity
        let fileEntity = brain.store.findEntitiesByName(`file:${link.file_path}`, brain.activeProjectId)[0];
        if (!fileEntity) {
          fileEntity = brain.store.addEntity({
            name: `file:${link.file_path}`,
            type: 'file',
            projectId: brain.activeProjectId,
            content: fileDigest.summary,
            metadata: { fileDigestId: fileDigest.id, language: fileDigest.language },
          });
        }

        // Find target entity by name or ID
        let targetEntity = brain.store.getEntity(link.entity_name_or_id);
        if (!targetEntity) {
          const candidates = brain.store.findEntitiesByName(link.entity_name_or_id, brain.activeProjectId);
          // exact name match preferred
          targetEntity = candidates.find(e => e.name === link.entity_name_or_id) ?? candidates[0] ?? null;
        }
        if (!targetEntity) {
          errors.push(`Entity not found: ${link.entity_name_or_id}`);
          continue;
        }

        // Create relation: targetEntity --defined_in--> fileEntity
        const relationType = link.relation_type ?? 'defined_in';
        brain.store.addRelation({
          fromEntityId: targetEntity.id,
          toEntityId: fileEntity.id,
          type: relationType,
        });
        created++;
      }

      const parts = [`Created ${created} link(s).`];
      if (errors.length > 0) {
        parts.push(`Errors:\n${errors.map(e => `- ${e}`).join('\n')}`);
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n\n') }],
      };
    },
  );

  server.tool(
    'devbrain_unlink_files',
    'Remove file-entity links. If entity is not specified, removes all links for the file.',
    {
      file_path: z.string().describe('File path to unlink'),
      entity_name_or_id: z.string().optional().describe('Specific entity to unlink from (omit to unlink all)'),
    },
    async ({ file_path, entity_name_or_id }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      // Find the file entity
      const fileEntities = brain.store.findEntitiesByName(`file:${file_path}`, brain.activeProjectId);
      const fileEntity = fileEntities.find(e => e.name === `file:${file_path}`);
      if (!fileEntity) {
        return { content: [{ type: 'text' as const, text: `No file entity found for: ${file_path}` }], isError: true };
      }

      // Get all relations involving this file entity
      const relations = brain.store.getRelations(fileEntity.id, 'both');

      let removed = 0;
      if (entity_name_or_id) {
        // Find target entity
        let targetEntity = brain.store.getEntity(entity_name_or_id);
        if (!targetEntity) {
          const candidates = brain.store.findEntitiesByName(entity_name_or_id, brain.activeProjectId);
          targetEntity = candidates.find(e => e.name === entity_name_or_id) ?? candidates[0] ?? null;
        }
        if (!targetEntity) {
          return { content: [{ type: 'text' as const, text: `Entity not found: ${entity_name_or_id}` }], isError: true };
        }

        for (const rel of relations) {
          if (rel.fromEntityId === targetEntity.id || rel.toEntityId === targetEntity.id) {
            brain.store.deleteRelation(rel.id);
            removed++;
          }
        }
      } else {
        // Remove all relations for this file entity
        for (const rel of relations) {
          brain.store.deleteRelation(rel.id);
          removed++;
        }
      }

      return {
        content: [{ type: 'text' as const, text: `Removed ${removed} link(s) for file "${file_path}".` }],
      };
    },
  );
}
