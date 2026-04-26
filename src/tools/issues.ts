import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerIssueTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_report_issue',
    'Report a bug, debt, todo, or improvement in the knowledge graph',
    {
      type: z.enum(['bug', 'debt', 'todo', 'improvement']).describe('Issue type'),
      title: z.string().describe('Issue title'),
      description: z.string().optional().describe('Detailed description'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Issue severity (default: medium)'),
      entity_id: z.string().optional().describe('Related entity ID'),
      file_path: z.string().optional().describe('Related file path'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ type, title, description, severity, entity_id, file_path, metadata }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const issue = brain.store.addIssue({
        projectId: brain.activeProjectId,
        type,
        title,
        description: description ?? null,
        severity,
        entityId: entity_id ?? null,
        filePath: file_path ?? null,
        metadata: metadata ?? null,
      });

      // Generate and store embedding
      const text = [title, description].filter(Boolean).join(': ');
      try {
        const embedding = await brain.embeddingProvider.embed(text);
        brain.vectorStore.upsertIssueEmbedding(issue.id, embedding);
      } catch (e) {
        console.error('Failed to generate issue embedding:', e);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(issue, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_get_issue',
    'Get an issue by ID',
    {
      id: z.string().describe('Issue ID'),
    },
    async ({ id }) => {
      const issue = brain.store.getIssue(id);
      if (!issue) {
        return { content: [{ type: 'text' as const, text: `Issue not found: ${id}` }], isError: true };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(issue, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_update_issue',
    'Update an existing issue',
    {
      id: z.string().describe('Issue ID to update'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('New severity'),
      status: z.enum(['open', 'in_progress', 'resolved', 'wontfix']).optional().describe('New status'),
      resolution: z.string().optional().describe('Resolution description'),
      entity_id: z.string().optional().describe('Related entity ID'),
      file_path: z.string().optional().describe('Related file path'),
      type: z.enum(['bug', 'debt', 'todo', 'improvement']).optional().describe('New type'),
      metadata: z.record(z.unknown()).optional().describe('New metadata'),
    },
    async ({ id, title, description, severity, status, resolution, entity_id, file_path, type, metadata }) => {
      const issue = brain.store.updateIssue(id, {
        title,
        description,
        severity,
        status,
        resolution,
        entityId: entity_id,
        filePath: file_path,
        type,
        metadata,
      });

      // Re-embed if title or description changed
      if (title !== undefined || description !== undefined) {
        const text = [issue.title, issue.description].filter(Boolean).join(': ');
        try {
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertIssueEmbedding(issue.id, embedding);
        } catch (e) {
          console.error('Failed to generate issue embedding:', e);
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(issue, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_list_issues',
    'List issues for the active project with optional filters',
    {
      type: z.enum(['bug', 'debt', 'todo', 'improvement']).optional().describe('Filter by issue type'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by severity'),
      status: z.enum(['open', 'in_progress', 'resolved', 'wontfix']).optional().describe('Filter by status'),
      entity_id: z.string().optional().describe('Filter by related entity'),
      file_path: z.string().optional().describe('Filter by related file'),
      limit: z.number().min(1).max(500).optional().describe('Max number of results (default 100)'),
      offset: z.number().min(0).optional().describe('Number of results to skip (default 0)'),
    },
    async ({ type, severity, status, entity_id, file_path, limit, offset }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const issues = brain.store.listIssues(brain.activeProjectId, {
        type,
        severity,
        status,
        entityId: entity_id,
        filePath: file_path,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });

      return {
        content: [{
          type: 'text' as const,
          text: issues.length > 0
            ? JSON.stringify(issues, null, 2)
            : 'No issues found.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_resolve_issue',
    'Shortcut to resolve an issue with a resolution description',
    {
      id: z.string().describe('Issue ID to resolve'),
      resolution: z.string().describe('Resolution description'),
    },
    async ({ id, resolution }) => {
      const issue = brain.store.updateIssue(id, {
        status: 'resolved',
        resolution,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(issue, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_delete_issue',
    'Delete an issue and its embedding',
    {
      id: z.string().describe('Issue ID to delete'),
    },
    async ({ id }) => {
      const issue = brain.store.getIssue(id);
      if (!issue) {
        return { content: [{ type: 'text' as const, text: `Issue not found: ${id}` }], isError: true };
      }

      brain.vectorStore.deleteIssueEmbedding(id);
      brain.store.deleteIssue(id);

      return {
        content: [{ type: 'text' as const, text: `Deleted issue "${issue.title}".` }],
      };
    },
  );
}
