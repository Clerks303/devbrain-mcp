import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerLessonTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_learn',
    'Record a lesson learned from experience (trigger situation → action to take)',
    {
      trigger: z.string().describe('The situation/trigger that causes this lesson to apply'),
      action: z.string().describe('What to do when this situation occurs'),
      outcome: z.enum(['positive', 'negative', 'neutral']).optional().describe('Whether this was a good or bad outcome (default: neutral)'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ trigger, action, outcome, metadata }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const lesson = brain.store.addLesson({
        projectId: brain.activeProjectId,
        trigger,
        action,
        outcome,
        metadata: metadata ?? null,
      });

      const text = `${trigger}: ${action}`;
      try {
        const embedding = await brain.embeddingProvider.embed(text);
        brain.vectorStore.upsertLessonEmbedding(lesson.id, embedding);
      } catch (e) {
        console.error('Failed to generate lesson embedding:', e);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(lesson, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_recall',
    'Recall relevant lessons for a given context/situation (semantic search)',
    {
      context: z.string().describe('Current situation/context to find relevant lessons for'),
      limit: z.number().min(1).max(20).optional().describe('Max results (default 5)'),
    },
    async ({ context, limit }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      try {
        const queryEmbedding = await brain.embeddingProvider.embed(context);
        const results = brain.vectorStore.searchLessons(queryEmbedding, limit ?? 5);

        const lessons = results
          .map(r => {
            const lesson = brain.store.getLesson(r.id);
            return lesson ? { ...lesson, distance: r.distance } : null;
          })
          .filter((l): l is NonNullable<typeof l> => l !== null && l.projectId === brain.activeProjectId)
          .sort((a, b) => b.confidence - a.confidence);

        return {
          content: [{
            type: 'text' as const,
            text: lessons.length > 0
              ? JSON.stringify(lessons, null, 2)
              : 'No relevant lessons found.',
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Recall failed: ${e}` }], isError: true };
      }
    },
  );

  server.tool(
    'devbrain_reinforce',
    'Reinforce a lesson (+1 occurrence, +0.1 confidence). Use when a lesson proves useful again.',
    {
      id: z.string().describe('Lesson ID to reinforce'),
    },
    async ({ id }) => {
      try {
        const lesson = brain.store.reinforceLesson(id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(lesson, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `${e}` }], isError: true };
      }
    },
  );

  server.tool(
    'devbrain_list_lessons',
    'List lessons for the active project with optional filters',
    {
      outcome: z.enum(['positive', 'negative', 'neutral']).optional().describe('Filter by outcome'),
      min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
      limit: z.number().min(1).max(500).optional().describe('Max number of results (default 100)'),
      offset: z.number().min(0).optional().describe('Number of results to skip (default 0)'),
    },
    async ({ outcome, min_confidence, limit, offset }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const lessons = brain.store.listLessons(brain.activeProjectId, {
        outcome,
        minConfidence: min_confidence,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });

      return {
        content: [{
          type: 'text' as const,
          text: lessons.length > 0
            ? JSON.stringify(lessons, null, 2)
            : 'No lessons found.',
        }],
      };
    },
  );
}
