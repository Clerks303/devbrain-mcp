import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerHealthTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_project_health',
    'Get a health dashboard for the active project: graph stats, coverage, staleness, issues, file stats, recent activity, top lessons',
    {},
    async () => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const projectId = brain.activeProjectId;
      const db = brain.store.getDb();

      // Graph summary
      const graphSummary = brain.store.getGraphSummary(projectId);

      // Coverage: % entities with >=1 observation, % entities with >=1 relation
      let observationCoverage = 0;
      let relationCoverage = 0;
      if (graphSummary.entityCount > 0) {
        const withObs = (db.prepare(`
          SELECT COUNT(DISTINCT e.id) as c FROM entities e
          INNER JOIN observations o ON o.entity_id = e.id
          WHERE (e.project_id = ? OR e.project_id IS NULL)
        `).get(projectId) as { c: number }).c;
        observationCoverage = Math.round((withObs / graphSummary.entityCount) * 100);

        const withRel = (db.prepare(`
          SELECT COUNT(DISTINCT e.id) as c FROM entities e
          WHERE (e.project_id = ? OR e.project_id IS NULL)
          AND (e.id IN (SELECT from_entity_id FROM relations) OR e.id IN (SELECT to_entity_id FROM relations))
        `).get(projectId) as { c: number }).c;
        relationCoverage = Math.round((withRel / graphSummary.entityCount) * 100);
      }

      // Staleness: entities not modified in 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const staleEntities = (db.prepare(`
        SELECT COUNT(*) as c FROM entities
        WHERE (project_id = ? OR project_id IS NULL) AND updated_at < ?
      `).get(projectId, thirtyDaysAgo) as { c: number }).c;

      // Issue breakdown
      let issueBreakdown: Record<string, unknown> = {};
      try {
        const issues = brain.store.listIssues(projectId);
        const bySeverity: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        for (const issue of issues) {
          bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
          byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
        }
        issueBreakdown = { bySeverity, byStatus, total: issues.length };
      } catch { /* table may not exist */ }

      // File stats
      let fileStats: Record<string, unknown> = {};
      try {
        const files = brain.store.listFileDigests(projectId);
        const byStatus: Record<string, number> = {};
        const byLanguage: Record<string, number> = {};
        for (const f of files) {
          byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
          if (f.language) byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;
        }
        fileStats = { byStatus, byLanguage, total: files.length };
      } catch { /* table may not exist */ }

      // Recent activity: last 5 sessions
      let recentSessions: unknown[] = [];
      try {
        recentSessions = brain.store.listSessions(projectId, 5).map(s => ({
          id: s.id,
          goal: s.goal,
          summary: s.summary,
          toolCalls: s.toolCalls,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
        }));
      } catch { /* table may not exist */ }

      // Top lessons
      let topLessons: unknown[] = [];
      try {
        topLessons = brain.store.listLessons(projectId).slice(0, 5).map(l => ({
          trigger: l.trigger,
          action: l.action,
          outcome: l.outcome,
          confidence: l.confidence,
          occurrences: l.occurrences,
        }));
      } catch { /* table may not exist */ }

      // Rule count
      let ruleCount = 0;
      try { ruleCount = brain.store.listRules(projectId).length; } catch { /* ignore */ }

      const dashboard = {
        graphSummary,
        coverage: {
          observationCoverage: `${observationCoverage}%`,
          relationCoverage: `${relationCoverage}%`,
        },
        staleness: {
          staleEntities,
          threshold: '30 days',
        },
        issueBreakdown,
        fileStats,
        recentSessions,
        topLessons,
        ruleCount,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(dashboard, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_reindex_embeddings',
    'Re-generate all vector embeddings for the active project. Use this after changing embedding providers (e.g., Ollama → OpenAI) or if semantic search returns no results.',
    {
      dry_run: z.boolean().optional().describe('Preview counts without executing (default: false)'),
    },
    async ({ dry_run }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const projectId = brain.activeProjectId;
      const entities = brain.store.listEntities(projectId, undefined, 10000, 0);
      let totalObservations = 0;
      for (const e of entities) {
        totalObservations += brain.store.getObservations(e.id).length;
      }
      const files = brain.store.listFileDigests(projectId, { limit: 10000 });
      const rules = brain.store.listRules(projectId, undefined, 10000, 0);
      const lessons = brain.store.listLessons(projectId, { limit: 10000 });

      const counts = {
        entities: entities.length,
        observations: totalObservations,
        files: files.length,
        rules: rules.length,
        lessons: lessons.length,
      };

      if (dry_run) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ dry_run: true, would_reindex: counts }, null, 2) }],
        };
      }

      const reindexed = { entities: 0, observations: 0, files: 0, rules: 0, lessons: 0 };

      for (const e of entities) {
        try {
          const text = [e.name, e.content].filter(Boolean).join(': ');
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertEntityEmbedding(e.id, embedding);
          reindexed.entities++;
        } catch { /* skip on error */ }
      }

      for (const e of entities) {
        for (const obs of brain.store.getObservations(e.id)) {
          try {
            const embedding = await brain.embeddingProvider.embed(obs.content);
            brain.vectorStore.upsertObservationEmbedding(obs.id, embedding);
            reindexed.observations++;
          } catch { /* skip */ }
        }
      }

      for (const f of files) {
        try {
          const text = [f.path, f.summary].filter(Boolean).join(': ');
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertFileDigestEmbedding(f.id, embedding);
          reindexed.files++;
        } catch { /* skip */ }
      }

      for (const r of rules) {
        try {
          const embedding = await brain.embeddingProvider.embed(r.content);
          brain.vectorStore.upsertRuleEmbedding(r.id, embedding);
          reindexed.rules++;
        } catch { /* skip */ }
      }

      for (const l of lessons) {
        try {
          const embedding = await brain.embeddingProvider.embed(`${l.trigger} → ${l.action}`);
          brain.vectorStore.upsertLessonEmbedding(l.id, embedding);
          reindexed.lessons++;
        } catch { /* skip */ }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ reindexed }, null, 2) }],
      };
    },
  );
}
