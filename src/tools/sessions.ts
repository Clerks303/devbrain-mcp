import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { getAutoContext } from '../graph/context-auto.js';
import { tryEmbed } from '../embeddings/try-embed.js';
import { SESSION_EVENT_TYPES } from '../types.js';

export function registerSessionTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_start_session',
    'Start a new work session with a goal. Returns the session ID for logging events.',
    {
      goal: z.string().describe('The goal/objective of this session'),
    },
    async ({ goal }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const session = brain.store.startSession({ projectId: brain.activeProjectId, goal });
      brain.activeSessionId = session.id;

      const embedding = await tryEmbed(brain.embeddingProvider, goal, 'session:start');
      if (embedding) brain.vectorStore.upsertSessionEmbedding(session.id, embedding);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_end_session',
    'End a work session, optionally with a summary. Re-embeds with the summary for better search.',
    {
      session_id: z.string().describe('Session ID to end'),
      summary: z.string().optional().describe('Summary of what was accomplished'),
    },
    async ({ session_id, summary }) => {
      const existing = brain.store.getSession(session_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${session_id}` }], isError: true };
      }

      const session = brain.store.endSession(session_id, summary);
      if (brain.activeSessionId === session_id) {
        brain.activeSessionId = null;
      }

      const text = [session.goal, summary].filter(Boolean).join(' — ');
      const embedding = await tryEmbed(brain.embeddingProvider, text, 'session:end');
      if (embedding) brain.vectorStore.upsertSessionEmbedding(session.id, embedding);

      // Trigger learning engine non-blockingly
      if (brain.learningOrchestrator) {
        brain.learningOrchestrator.processSession(session_id, session.projectId)
          .then(report => {
            brain.lastLearningReport = report;
            if (report.lessonsGenerated > 0 || report.ruleProposalsPending > 0) {
              console.error(`[Learning] ${report.lessonsGenerated} lessons, ${report.ruleProposalsPending} proposals`);
            }
          })
          .catch(err => console.error('[Learning] Processing failed:', err));
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_log_event',
    'Log an event in the current session (tool call, decision, discovery, or error)',
    {
      session_id: z.string().describe('Session ID to log event in'),
      type: z.enum(SESSION_EVENT_TYPES).describe('Event type'),
      content: z.string().describe('Event description'),
      tool_name: z.string().optional().describe('Tool name (for tool_call events)'),
    },
    async ({ session_id, type, content, tool_name }) => {
      const session = brain.store.getSession(session_id);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${session_id}` }], isError: true };
      }

      const event = brain.store.addSessionEvent({
        sessionId: session_id,
        type,
        content,
        toolName: tool_name ?? null,
      });

      if (type === 'tool_call') {
        brain.store.updateSessionCounters(session_id, { toolCalls: 1 });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(event, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_get_session',
    'Get a session by ID (or the last active session) with its events',
    {
      session_id: z.string().optional().describe('Session ID (omit to get the last active session)'),
    },
    async ({ session_id }) => {
      let session;
      if (session_id) {
        session = brain.store.getSession(session_id);
      } else if (brain.activeProjectId) {
        session = brain.store.getLastSession(brain.activeProjectId);
      }

      if (!session) {
        return { content: [{ type: 'text' as const, text: 'No session found.' }], isError: true };
      }

      const events = brain.store.getSessionEvents(session.id);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...session, events }, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_list_sessions',
    'List recent sessions for the active project',
    {
      limit: z.number().min(1).max(500).optional().describe('Max number of sessions (default 10)'),
      offset: z.number().min(0).optional().describe('Number of results to skip (default 0)'),
    },
    async ({ limit, offset }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const sessions = brain.store.listSessions(brain.activeProjectId, limit ?? 10, offset ?? 0);

      return {
        content: [{
          type: 'text' as const,
          text: sessions.length > 0
            ? JSON.stringify(sessions, null, 2)
            : 'No sessions found.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_quick_start',
    'One-call session bootstrap: set project + start session + get auto context. Replaces 3 separate calls at the start of every session.',
    {
      project_path: z.string().describe('Absolute path of the project directory'),
      goal: z.string().describe('The goal/objective of this session'),
      context_query: z.string().optional().describe('Query for auto context (defaults to goal)'),
    },
    async ({ project_path, goal, context_query }) => {
      // 1. Set project
      const projectName = project_path.split('/').filter(Boolean).pop() ?? 'unknown';
      let project = brain.store.getProjectByPath(project_path);
      if (!project) {
        project = brain.store.addProject({ name: projectName, path: project_path });
      }
      brain.activeProjectId = project.id;

      // 2. Start session
      const session = brain.store.startSession({ projectId: project.id, goal });
      brain.activeSessionId = session.id;
      const embedding = await tryEmbed(brain.embeddingProvider, goal, 'session:quick-start');
      if (embedding) brain.vectorStore.upsertSessionEmbedding(session.id, embedding);

      // 3. Get auto context
      const query = context_query ?? goal;
      let contextReport = 'No prior context found.';
      try {
        const result = await getAutoContext(
          brain.store, brain.vectorStore, brain.embeddingProvider, project.id,
          { query, limit: 5 },
        );
        const sections: string[] = [];
        if (result.entities.length > 0) {
          sections.push('## Relevant Entities\n' + result.entities.map(e =>
            `- **${e.entity.name}** (${e.entity.type})${e.entity.content ? `: ${e.entity.content}` : ''}`
          ).join('\n'));
        }
        if (result.rules.length > 0) {
          sections.push('## Rules\n' + result.rules.map(r => `- [${r.severity.toUpperCase()}] ${r.content}`).join('\n'));
        }
        if (result.lessons.length > 0) {
          sections.push('## Lessons\n' + result.lessons.map(l => `- [${l.outcome}, ${l.confidence}] "${l.trigger}" → ${l.action}`).join('\n'));
        }
        if (result.openIssues.length > 0) {
          sections.push('## Open Issues\n' + result.openIssues.map(i => `- [${i.severity}] ${i.title}`).join('\n'));
        }
        if (result.lastSession) {
          const s = result.lastSession;
          sections.push(`## Last Session\n- Goal: ${s.goal}${s.summary ? `\n- Summary: ${s.summary}` : ''}`);
        }
        if (sections.length > 0) contextReport = sections.join('\n\n');
      } catch (err) {
        console.error(`[quick-start:auto-context] ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: `# Session Started\n\n**Project**: ${project.name} (${project.id})\n**Session ID**: ${session.id}\n**Goal**: ${goal}\n\n${contextReport}`,
        }],
      };
    },
  );
}
