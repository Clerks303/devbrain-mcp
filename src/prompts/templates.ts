import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'devbrain_onboard',
    'Generate a prompt to onboard a new project into DevBrain by extracting its key entities and architecture',
    { project_path: z.string().describe('Path to the project to onboard') },
    async ({ project_path }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I want to onboard the project at "${project_path}" into DevBrain. Please help me extract and store the key knowledge:

1. **Set the project**: Call \`devbrain_set_project\` with the path "${project_path}"

2. **Identify key entities** by reading the project structure and source code:
   - Main modules/packages
   - Key classes and functions
   - Architectural patterns used
   - Important decisions and conventions
   - External dependencies

3. **For each entity found**, call \`devbrain_add_entity\` with:
   - A clear name
   - The appropriate type (module, class, function, pattern, decision, convention, dependency)
   - A concise but informative description as content

4. **Create relations** between entities using \`devbrain_add_relation\`:
   - imports, calls, depends_on, implements, related_to

5. **Add observations** for important facts using \`devbrain_add_observation\`:
   - Architectural decisions and their rationale
   - Code conventions
   - Known issues or technical debt
   - Performance considerations

Please proceed step by step, starting with setting the project and then analyzing its structure.`,
        },
      }],
    }),
  );

  server.prompt(
    'devbrain_recall',
    'Generate a prompt to recall relevant context from DevBrain for a specific task',
    { task: z.string().describe('Description of the task you need context for') },
    async ({ task }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Before starting this task, recall relevant context from DevBrain:

**Task**: ${task}

Please:
1. Call \`devbrain_search\` with a query derived from the task description to find relevant entities
2. For each relevant entity found, call \`devbrain_get_context\` to get its full context (relations + observations)
3. Summarize the relevant knowledge that will help with this task
4. Identify any related decisions, patterns, or conventions that should be followed

Then proceed with the task using this recalled context.`,
        },
      }],
    }),
  );
}
