import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerProjectTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_set_project',
    'Set the active project. Creates it if it does not exist. All subsequent operations will be scoped to this project.',
    {
      path: z.string().describe('Absolute path of the project directory'),
      name: z.string().optional().describe('Human-readable project name (defaults to directory name)'),
    },
    async ({ path: projectPath, name }) => {
      const projectName = name ?? projectPath.split('/').filter(Boolean).pop() ?? 'unknown';

      // Check if project already exists
      let project = brain.store.getProjectByPath(projectPath);
      if (!project) {
        project = brain.store.addProject({
          name: projectName,
          path: projectPath,
        });
      }

      brain.activeProjectId = project.id;

      return {
        content: [{
          type: 'text' as const,
          text: `Active project set to "${project.name}" (${project.id})\nPath: ${projectPath}`,
        }],
      };
    },
  );

  server.tool(
    'devbrain_list_projects',
    'List all known projects',
    {
      limit: z.number().min(1).max(500).optional().describe('Max number of results (default 100)'),
      offset: z.number().min(0).optional().describe('Number of results to skip (default 0)'),
    },
    async ({ limit, offset }) => {
      const projects = brain.store.listProjects(limit ?? 100, offset ?? 0);

      if (projects.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No projects found. Use devbrain_set_project to add one.' }] };
      }

      const formatted = projects.map(p => ({
        id: p.id,
        name: p.name,
        path: p.path,
        active: p.id === brain.activeProjectId,
        createdAt: p.createdAt,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
      };
    },
  );
}
