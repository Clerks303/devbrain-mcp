import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { tryEmbed } from '../embeddings/try-embed.js';

export function registerFileTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_digest_file',
    'Upsert a file digest (structured memory of a file: summary, exports, imports, hash, etc.)',
    {
      path: z.string().describe('File path relative to project root'),
      content_hash: z.string().optional().describe('Hash of the file content for staleness detection'),
      summary: z.string().optional().describe('Brief summary of the file purpose and contents'),
      exports: z.array(z.string()).optional().describe('Exported symbols (functions, classes, types, etc.)'),
      imports: z.array(z.string()).optional().describe('Imported modules/packages'),
      language: z.string().optional().describe('Programming language'),
      loc: z.number().optional().describe('Lines of code'),
      status: z.enum(['active', 'deprecated', 'draft', 'deleted']).optional().describe('File status'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ path, content_hash, summary, exports, imports, language, loc, status, metadata }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const digest = brain.store.upsertFileDigest({
        projectId: brain.activeProjectId,
        path,
        contentHash: content_hash ?? null,
        summary: summary ?? null,
        exports,
        imports,
        language: language ?? null,
        loc: loc ?? null,
        status,
        metadata: metadata ?? null,
      });

      if (summary || path) {
        const text = [path, summary].filter(Boolean).join(': ');
        const embedding = await tryEmbed(brain.embeddingProvider, text, 'file:digest');
        if (embedding) brain.vectorStore.upsertFileDigestEmbedding(digest.id, embedding);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(digest, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_get_file',
    'Get the digest of a file by its path',
    {
      path: z.string().describe('File path relative to project root'),
    },
    async ({ path }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const digest = brain.store.getFileDigestByPath(brain.activeProjectId, path);
      if (!digest) {
        return { content: [{ type: 'text' as const, text: `No digest found for file: ${path}` }], isError: true };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(digest, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_list_files',
    'List all file digests for the active project',
    {
      status: z.enum(['active', 'deprecated', 'draft', 'deleted']).optional().describe('Filter by file status'),
      language: z.string().optional().describe('Filter by programming language'),
      limit: z.number().min(1).max(500).optional().describe('Max number of results (default 100)'),
      offset: z.number().min(0).optional().describe('Number of results to skip (default 0)'),
    },
    async ({ status, language, limit, offset }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const digests = brain.store.listFileDigests(brain.activeProjectId, { status, language, limit: limit ?? 100, offset: offset ?? 0 });

      return {
        content: [{
          type: 'text' as const,
          text: digests.length > 0
            ? JSON.stringify(digests.map(d => ({ id: d.id, path: d.path, language: d.language, loc: d.loc, status: d.status, summary: d.summary })), null, 2)
            : 'No file digests found.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_check_files',
    'Check which files are stale by comparing content hashes',
    {
      files: z.array(z.object({
        path: z.string().describe('File path'),
        hash: z.string().describe('Current content hash'),
      })).describe('Array of files with their current hashes to check'),
    },
    async ({ files }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const results = brain.store.checkFilesStaleness(brain.activeProjectId, files);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_delete_file',
    'Delete a file digest and its embedding',
    {
      path: z.string().describe('File path to delete digest for'),
    },
    async ({ path }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const digest = brain.store.getFileDigestByPath(brain.activeProjectId, path);
      if (!digest) {
        return { content: [{ type: 'text' as const, text: `No digest found for file: ${path}` }], isError: true };
      }

      brain.vectorStore.deleteFileDigestEmbedding(digest.id);
      brain.store.deleteFileDigest(digest.id);

      return {
        content: [{ type: 'text' as const, text: `Deleted file digest for "${path}".` }],
      };
    },
  );
}
