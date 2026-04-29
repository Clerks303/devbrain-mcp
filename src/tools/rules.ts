import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { tryEmbed } from '../embeddings/try-embed.js';

export function registerRuleTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_add_rule',
    'Add a project rule or convention (coding style, architecture decisions, etc.)',
    {
      scope: z.enum(['global', 'file_pattern', 'entity_type']).optional().describe('Rule scope (default: global)'),
      pattern: z.string().optional().describe('Glob pattern for file_pattern scope, or type name for entity_type scope'),
      content: z.string().describe('The rule content'),
      severity: z.enum(['must', 'should', 'prefer']).optional().describe('Rule severity (default: should)'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ scope, pattern, content, severity, metadata }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const rule = brain.store.addRule({
        projectId: brain.activeProjectId,
        scope,
        pattern: pattern ?? null,
        content,
        severity,
        metadata: metadata ?? null,
      });

      const embedding = await tryEmbed(brain.embeddingProvider, content, 'rule:add');
      if (embedding) brain.vectorStore.upsertRuleEmbedding(rule.id, embedding);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rule, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_get_rules',
    'Get applicable rules for the current context (file path, entity type, or all)',
    {
      scope: z.enum(['global', 'file_pattern', 'entity_type']).optional().describe('Filter by scope'),
      file_path: z.string().optional().describe('File path to match against file_pattern rules'),
      entity_type: z.string().optional().describe('Entity type to match against entity_type rules'),
    },
    async ({ scope, file_path, entity_type }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      let rules;
      if (file_path || entity_type) {
        rules = brain.store.matchRules(brain.activeProjectId, { filePath: file_path, entityType: entity_type });
      } else {
        rules = brain.store.listRules(brain.activeProjectId, scope);
      }

      return {
        content: [{
          type: 'text' as const,
          text: rules.length > 0
            ? JSON.stringify(rules, null, 2)
            : 'No rules found.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_update_rule',
    'Update an existing rule',
    {
      id: z.string().describe('Rule ID to update'),
      content: z.string().optional().describe('New rule content'),
      severity: z.enum(['must', 'should', 'prefer']).optional().describe('New severity'),
      scope: z.enum(['global', 'file_pattern', 'entity_type']).optional().describe('New scope'),
      pattern: z.string().optional().describe('New pattern'),
    },
    async ({ id, content, severity, scope, pattern }) => {
      const rule = brain.store.updateRule(id, { content, severity, scope, pattern });

      if (content !== undefined) {
        const embedding = await tryEmbed(brain.embeddingProvider, rule.content, 'rule:update');
        if (embedding) brain.vectorStore.upsertRuleEmbedding(rule.id, embedding);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rule, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_search_rules',
    'Semantic search across project rules',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().min(1).max(20).optional().describe('Max results (default 5)'),
    },
    async ({ query, limit }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      try {
        const queryEmbedding = await brain.embeddingProvider.embed(query);
        const results = brain.vectorStore.searchRules(queryEmbedding, limit ?? 5);

        const rules = results
          .map(r => {
            const rule = brain.store.getRule(r.id);
            return rule ? { ...rule, distance: r.distance } : null;
          })
          .filter((r): r is NonNullable<typeof r> => r !== null && r.projectId === brain.activeProjectId);

        return {
          content: [{
            type: 'text' as const,
            text: rules.length > 0
              ? JSON.stringify(rules, null, 2)
              : 'No matching rules found.',
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Search failed: ${e}` }], isError: true };
      }
    },
  );

  server.tool(
    'devbrain_delete_rule',
    'Delete a rule and its embedding',
    {
      id: z.string().describe('Rule ID to delete'),
    },
    async ({ id }) => {
      const rule = brain.store.getRule(id);
      if (!rule) {
        return { content: [{ type: 'text' as const, text: `Rule not found: ${id}` }], isError: true };
      }

      brain.vectorStore.deleteRuleEmbedding(id);
      brain.store.deleteRule(id);

      return {
        content: [{ type: 'text' as const, text: `Deleted rule: "${rule.content.substring(0, 80)}..."` }],
      };
    },
  );
}
