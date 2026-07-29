import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';

interface TableRowCount {
  readonly name: string;
  readonly count: number;
}

const TABLES_TO_COUNT = [
  'projects',
  'entities',
  'relations',
  'observations',
  'file_digests',
  'issues',
  'sessions',
  'session_events',
  'rules',
  'lessons',
  'snapshots',
] as const;

function getTableCounts(brain: DevBrain): TableRowCount[] {
  const db = brain.store.getDb();
  return TABLES_TO_COUNT.map(table => {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      return { name: table, count: row.c };
    } catch {
      return { name: table, count: 0 };
    }
  });
}

function getDbFileSize(dbPath: string): number | null {
  try {
    const stat = fs.statSync(dbPath);
    return stat.size;
  } catch {
    return null;
  }
}

function getStoredDimension(brain: DevBrain): number | null {
  try {
    const db = brain.store.getDb();
    const row = db.prepare(
      "SELECT value FROM meta WHERE key = 'embedding_dimension'"
    ).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : null;
  } catch {
    return null;
  }
}

export function registerMetricsTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_metrics',
    'Get server metrics: DB size, row counts per table, embedding dimension, provider type, uptime, version',
    {},
    async () => {
      const dbSizeBytes = getDbFileSize(brain.dbPath);
      const tableCounts = getTableCounts(brain);
      const embeddingDimension = getStoredDimension(brain) ?? brain.embeddingProvider.dimension;
      const providerType = brain.config.embeddingProvider;
      const uptimeMs = Date.now() - brain.startedAt.getTime();
      const uptimeSeconds = Math.floor(uptimeMs / 1000);

      const metrics = {
        version: '0.1.1',
        uptime: {
          seconds: uptimeSeconds,
          human: formatUptime(uptimeSeconds),
        },
        database: {
          path: brain.dbPath,
          sizeBytes: dbSizeBytes,
          sizeHuman: dbSizeBytes !== null ? formatBytes(dbSizeBytes) : 'unknown',
        },
        tables: Object.fromEntries(tableCounts.map(t => [t.name, t.count])),
        embedding: {
          provider: providerType,
          dimension: embeddingDimension,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(metrics, null, 2) }],
      };
    },
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}
