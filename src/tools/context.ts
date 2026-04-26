import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { getAutoContext } from '../graph/context-auto.js';

export function registerContextTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_auto_context',
    'Get comprehensive context for a task: relevant entities, applicable rules, lessons learned, open issues, and last session. One-stop shop for "what do I need to know?"',
    {
      query: z.string().describe('What you are about to work on (natural language)'),
      file_path: z.string().optional().describe('File path to match rules against'),
      entity_type: z.string().optional().describe('Entity type to match rules against'),
      include_rules: z.boolean().optional().describe('Include applicable rules (default: true)'),
      include_lessons: z.boolean().optional().describe('Include relevant lessons (default: true)'),
      include_issues: z.boolean().optional().describe('Include open issues (default: true)'),
      limit: z.number().min(1).max(20).optional().describe('Max entities to return (default: 5)'),
    },
    async ({ query, file_path, entity_type, include_rules, include_lessons, include_issues, limit }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const result = await getAutoContext(
        brain.store,
        brain.vectorStore,
        brain.embeddingProvider,
        brain.activeProjectId,
        {
          query,
          filePath: file_path,
          entityType: entity_type,
          includeRules: include_rules,
          includeLessons: include_lessons,
          includeIssues: include_issues,
          limit,
        },
      );

      // Format as a structured markdown report
      const sections: string[] = [];

      // Entities
      if (result.entities.length > 0) {
        sections.push('## Relevant Entities\n' + result.entities.map(e =>
          `- **${e.entity.name}** (${e.entity.type}, score: ${Math.round(e.score * 100) / 100})${e.entity.content ? `: ${e.entity.content}` : ''}${e.observations.length > 0 ? `\n  Observations: ${e.observations.map(o => o.content).join('; ')}` : ''}`
        ).join('\n'));
      }

      // Rules
      if (result.rules.length > 0) {
        sections.push('## Applicable Rules\n' + result.rules.map(r =>
          `- [${r.severity.toUpperCase()}] ${r.content}${r.scope !== 'global' ? ` (${r.scope}: ${r.pattern})` : ''}`
        ).join('\n'));
      }

      // Lessons
      if (result.lessons.length > 0) {
        sections.push('## Lessons Learned\n' + result.lessons.map(l =>
          `- [${l.outcome}, confidence: ${l.confidence}] When "${l.trigger}" → ${l.action}`
        ).join('\n'));
      }

      // Open issues
      if (result.openIssues.length > 0) {
        sections.push('## Open Issues\n' + result.openIssues.map(i =>
          `- [${i.severity}] ${i.title}${i.filePath ? ` (${i.filePath})` : ''}`
        ).join('\n'));
      }

      // Last session
      if (result.lastSession) {
        const s = result.lastSession;
        sections.push(`## Last Session\n- Goal: ${s.goal}${s.summary ? `\n- Summary: ${s.summary}` : ''}\n- Tools: ${s.toolCalls}, Entities modified: ${s.entitiesModified}`);
      }

      const report = sections.length > 0
        ? `# Auto Context for: "${query}"\n\n${sections.join('\n\n')}`
        : `No context found for: "${query}"`;

      return {
        content: [{ type: 'text' as const, text: report }],
      };
    },
  );
}
