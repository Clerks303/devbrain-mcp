import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

export function registerSnapshotTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_snapshot_create',
    'Create a snapshot of the current project graph (entities, relations, observations, files, issues, rules, lessons)',
    {
      label: z.string().describe('Snapshot label (e.g., "v1.0-release", "before-refactor")'),
      description: z.string().optional().describe('Optional description of what this snapshot captures'),
    },
    async ({ label, description }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const snapshot = brain.store.createSnapshot(brain.activeProjectId, label, description);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          id: snapshot.id,
          label: snapshot.label,
          description: snapshot.description,
          entityCount: snapshot.entityCount,
          relationCount: snapshot.relationCount,
          createdAt: snapshot.createdAt,
        }, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_snapshot_list',
    'List all snapshots for the active project (without data payload)',
    {
      limit: z.number().min(1).max(500).optional().describe('Max number of results (default 100)'),
      offset: z.number().min(0).optional().describe('Number of results to skip (default 0)'),
    },
    async ({ limit, offset }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const snapshots = brain.store.listSnapshots(brain.activeProjectId, limit ?? 100, offset ?? 0);

      return {
        content: [{
          type: 'text' as const,
          text: snapshots.length > 0
            ? JSON.stringify(snapshots, null, 2)
            : 'No snapshots found.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_snapshot_get',
    'Get a snapshot by ID with full data and statistics',
    {
      id: z.string().describe('Snapshot ID'),
    },
    async ({ id }) => {
      const snapshot = brain.store.getSnapshot(id);
      if (!snapshot) {
        return { content: [{ type: 'text' as const, text: `Snapshot not found: ${id}` }], isError: true };
      }

      let dataSummary: Record<string, number> = {};
      try {
        const parsed = JSON.parse(snapshot.data);
        dataSummary = {
          entities: parsed.entities?.length ?? 0,
          relations: parsed.relations?.length ?? 0,
          observations: parsed.observations?.length ?? 0,
          fileDigests: parsed.fileDigests?.length ?? 0,
          issues: parsed.issues?.length ?? 0,
          rules: parsed.rules?.length ?? 0,
          lessons: parsed.lessons?.length ?? 0,
        };
      } catch { /* ignore */ }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          id: snapshot.id,
          label: snapshot.label,
          description: snapshot.description,
          entityCount: snapshot.entityCount,
          relationCount: snapshot.relationCount,
          createdAt: snapshot.createdAt,
          dataSummary,
          data: snapshot.data,
        }, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_snapshot_delete',
    'Delete a snapshot',
    {
      id: z.string().describe('Snapshot ID to delete'),
    },
    async ({ id }) => {
      const snapshot = brain.store.getSnapshot(id);
      if (!snapshot) {
        return { content: [{ type: 'text' as const, text: `Snapshot not found: ${id}` }], isError: true };
      }

      brain.store.deleteSnapshot(id);

      return {
        content: [{ type: 'text' as const, text: `Deleted snapshot "${snapshot.label}".` }],
      };
    },
  );

  server.tool(
    'devbrain_snapshot_restore',
    'Restore project state from a snapshot. Overwrites all current entities, observations, relations, files, rules, and lessons with the snapshot data. Embeddings are regenerated after restore.',
    {
      id: z.string().describe('Snapshot ID to restore'),
      dry_run: z.boolean().optional().describe('Preview what would be restored without executing (default: false)'),
      skip_reembedding: z.boolean().optional().describe('Skip embedding regeneration after restore (default: false). Search will be broken until you run devbrain_reindex_embeddings.'),
    },
    async ({ id, dry_run, skip_reembedding }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const snapshot = brain.store.getSnapshot(id);
      if (!snapshot) {
        return { content: [{ type: 'text' as const, text: `Snapshot not found: ${id}` }], isError: true };
      }

      // Parse to get counts for dry-run
      let dataSummary: Record<string, number> = {};
      try {
        const parsed = JSON.parse(snapshot.data);
        dataSummary = {
          entities: parsed.entities?.length ?? 0,
          observations: parsed.observations?.length ?? 0,
          relations: parsed.relations?.length ?? 0,
          fileDigests: parsed.fileDigests?.length ?? 0,
          rules: parsed.rules?.length ?? 0,
          lessons: parsed.lessons?.length ?? 0,
        };
      } catch {
        return { content: [{ type: 'text' as const, text: 'Failed to parse snapshot data.' }], isError: true };
      }

      if (dry_run) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            dry_run: true,
            snapshot: { id: snapshot.id, label: snapshot.label, createdAt: snapshot.createdAt },
            would_restore: dataSummary,
          }, null, 2) }],
        };
      }

      const restored = brain.store.restoreSnapshot(brain.activeProjectId, id);

      // Re-generate embeddings unless skipped
      const reembedded: Record<string, number> = {};
      if (!skip_reembedding) {
        const projectId = brain.activeProjectId;
        const entities = brain.store.listEntities(projectId, undefined, 10000, 0);
        let count = 0;
        for (const e of entities) {
          try {
            const text = [e.name, e.content].filter(Boolean).join(': ');
            const embedding = await brain.embeddingProvider.embed(text);
            brain.vectorStore.upsertEntityEmbedding(e.id, embedding);
            count++;
          } catch { /* skip */ }
        }
        reembedded.entities = count;

        let obsCount = 0;
        for (const e of entities) {
          for (const obs of brain.store.getObservations(e.id)) {
            try {
              const embedding = await brain.embeddingProvider.embed(obs.content);
              brain.vectorStore.upsertObservationEmbedding(obs.id, embedding);
              obsCount++;
            } catch { /* skip */ }
          }
        }
        reembedded.observations = obsCount;

        let rulesCount = 0;
        for (const r of brain.store.listRules(projectId, undefined, 10000, 0)) {
          try {
            const embedding = await brain.embeddingProvider.embed(r.content);
            brain.vectorStore.upsertRuleEmbedding(r.id, embedding);
            rulesCount++;
          } catch { /* skip */ }
        }
        reembedded.rules = rulesCount;

        let lessonsCount = 0;
        for (const l of brain.store.listLessons(projectId, { limit: 10000 })) {
          try {
            const embedding = await brain.embeddingProvider.embed(`${l.trigger} → ${l.action}`);
            brain.vectorStore.upsertLessonEmbedding(l.id, embedding);
            lessonsCount++;
          } catch { /* skip */ }
        }
        reembedded.lessons = lessonsCount;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          restored,
          reembedded: skip_reembedding ? 'skipped' : reembedded,
          snapshot: { id: snapshot.id, label: snapshot.label },
        }, null, 2) }],
      };
    },
  );
}
