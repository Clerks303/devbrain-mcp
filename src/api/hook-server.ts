import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DevBrain } from '../server.js';
import { handleSessionStart, handlePostTool, handleSessionEnd } from './hook-handlers.js';

export interface HookServer {
  readonly port: number;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createHookServer(brain: DevBrain, port: number): HookServer {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const method = req.method ?? 'GET';

    // CORS headers for local scripts
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      if (url.pathname === '/health' && method === 'GET') {
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - brain.startedAt.getTime()) / 1000),
          activeProject: brain.activeProjectId,
          activeSession: brain.activeSessionId,
        });
        return;
      }

      if (method !== 'POST') {
        jsonResponse(res, 405, { error: 'Method not allowed' });
        return;
      }

      const body = await parseJsonBody(req);
      if (!body) {
        jsonResponse(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (url.pathname === '/api/hook/session-start') {
        const result = await handleSessionStart(brain, body);
        jsonResponse(res, 200, result);
        return;
      }

      if (url.pathname === '/api/hook/post-tool') {
        const result = await handlePostTool(brain, body);
        jsonResponse(res, 200, result);
        return;
      }

      if (url.pathname === '/api/hook/session-end') {
        const result = await handleSessionEnd(brain, body);
        jsonResponse(res, 200, result);
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[hook-server] Request error:', err);
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  });

  return {
    port,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
          console.error(`[devbrain] Hook server listening on http://127.0.0.1:${port}`);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
