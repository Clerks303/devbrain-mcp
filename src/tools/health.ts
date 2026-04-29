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

      // Track per-category attempts/successes/failures so the user can tell
      // a successful reindex from a silent embed-provider outage. Without
      // this, the tool reports `reindexed: { entities: 12 }` even when 80%
      // of calls 429'd — exactly the opposite of what a recovery tool
      // should do.
      type CategoryStats = { attempted: number; succeeded: number; failed: number };
      const stats = {
        entities: { attempted: 0, succeeded: 0, failed: 0 } as CategoryStats,
        observations: { attempted: 0, succeeded: 0, failed: 0 } as CategoryStats,
        files: { attempted: 0, succeeded: 0, failed: 0 } as CategoryStats,
        rules: { attempted: 0, succeeded: 0, failed: 0 } as CategoryStats,
        lessons: { attempted: 0, succeeded: 0, failed: 0 } as CategoryStats,
      };
      const errorSamples: string[] = [];
      const captureError = (err: unknown): void => {
        if (errorSamples.length < 5) errorSamples.push(String(err instanceof Error ? err.message : err));
      };

      for (const e of entities) {
        stats.entities.attempted++;
        try {
          const text = [e.name, e.content].filter(Boolean).join(': ');
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertEntityEmbedding(e.id, embedding);
          stats.entities.succeeded++;
        } catch (err) { stats.entities.failed++; captureError(err); }
      }

      for (const e of entities) {
        for (const obs of brain.store.getObservations(e.id)) {
          stats.observations.attempted++;
          try {
            const embedding = await brain.embeddingProvider.embed(obs.content);
            brain.vectorStore.upsertObservationEmbedding(obs.id, embedding);
            stats.observations.succeeded++;
          } catch (err) { stats.observations.failed++; captureError(err); }
        }
      }

      for (const f of files) {
        stats.files.attempted++;
        try {
          const text = [f.path, f.summary].filter(Boolean).join(': ');
          const embedding = await brain.embeddingProvider.embed(text);
          brain.vectorStore.upsertFileDigestEmbedding(f.id, embedding);
          stats.files.succeeded++;
        } catch (err) { stats.files.failed++; captureError(err); }
      }

      for (const r of rules) {
        stats.rules.attempted++;
        try {
          const embedding = await brain.embeddingProvider.embed(r.content);
          brain.vectorStore.upsertRuleEmbedding(r.id, embedding);
          stats.rules.succeeded++;
        } catch (err) { stats.rules.failed++; captureError(err); }
      }

      for (const l of lessons) {
        stats.lessons.attempted++;
        try {
          const embedding = await brain.embeddingProvider.embed(`${l.trigger} → ${l.action}`);
          brain.vectorStore.upsertLessonEmbedding(l.id, embedding);
          stats.lessons.succeeded++;
        } catch (err) { stats.lessons.failed++; captureError(err); }
      }

      const totalAttempted = Object.values(stats).reduce((s, c) => s + c.attempted, 0);
      const totalFailed = Object.values(stats).reduce((s, c) => s + c.failed, 0);
      // A repair tool that silently leaves >10% of items unindexed is worse
      // than no tool — surface it as an error so the agent knows to retry.
      const failureRatio = totalAttempted > 0 ? totalFailed / totalAttempted : 0;
      const isError = failureRatio > 0.1;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          stats,
          totalAttempted,
          totalFailed,
          failureRatio: Number(failureRatio.toFixed(3)),
          errorSamples: errorSamples.length > 0 ? errorSamples : undefined,
        }, null, 2) }],
        isError,
      };
    },
  );
}
