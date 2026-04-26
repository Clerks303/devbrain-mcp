import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { createHookServer } from './api/hook-server.js';

async function main(): Promise<void> {
  const { server, brain, config } = await createServer();

  // Start hook HTTP server for Claude Code hooks integration
  const hookPort = config.hookPort ?? 7384;
  const hookServer = createHookServer(brain, hookPort);
  hookServer.listen().catch((err) => {
    console.error(`[devbrain] Failed to start hook server on port ${hookPort}:`, err);
    console.error('[devbrain] Hooks will not be available. MCP server continues normally.');
  });

  if (config.transport === 'sse') {
    const port = config.port ?? 3100;
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('node:http');

    let sseTransport: InstanceType<typeof SSEServerTransport> | null = null;

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname === '/sse' && req.method === 'GET') {
        sseTransport = new SSEServerTransport('/messages', res);
        await server.connect(sseTransport);
      } else if (url.pathname === '/messages' && req.method === 'POST') {
        if (sseTransport) {
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('No active SSE connection');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    httpServer.listen(port, () => {
      console.error(`DevBrain MCP server running on SSE at http://localhost:${port}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('DevBrain MCP server running on stdio');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
