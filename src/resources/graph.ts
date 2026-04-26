import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerResources(server: McpServer, brain: DevBrain): void {
  // Graph summary resource
  server.resource(
    'graph-summary',
    'devbrain://graph/summary',
    async (uri) => {
      const summary = brain.store.getGraphSummary(brain.activeProjectId);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            activeProject: brain.activeProjectId,
            ...summary,
          }, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );

  // Project overview resource (template)
  server.resource(
    'project-overview',
    new ResourceTemplate('devbrain://project/{id}/overview', { list: undefined }),
    async (uri, { id }) => {
      const project = brain.store.getProject(id as string);
      if (!project) {
        return {
          contents: [{
            uri: uri.href,
            text: JSON.stringify({ error: `Project not found: ${id}` }),
            mimeType: 'application/json',
          }],
        };
      }

      const summary = brain.store.getGraphSummary(project.id);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            project,
            ...summary,
          }, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
