import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DevBrain } from '../server.js';
import { handleSessionStart, handlePostTool, handleSessionEnd } from './hook-handlers.js';

export interface HookServer {
  readonly port: number;
  listen(): Promise<void>;
  close(): Promise<void>;
}

// The hook server only receives small JSON payloads from local Claude Code
// hooks — anything bigger is a bug or an abuse attempt, not a legit request.
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export class PayloadTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        // Keep draining so the response can still be written, but discard data
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new PayloadTooLargeError());
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
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

type ParsedBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly status: 400 | 413; readonly error: string };

async function parseJsonBody(req: IncomingMessage): Promise<ParsedBody> {
  try {
    const raw = await readBody(req);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'Invalid JSON body' };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return { ok: false, status: 413, error: 'Payload too large' };
    }
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }
}

export function createHookServer(brain: DevBrain, port: number): HookServer {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const method = req.method ?? 'GET';

    // No CORS headers on purpose: callers are local scripts (curl, Node
    // hooks), never browsers. A wildcard here would open the server to
    // DNS-rebinding attacks from any web page.

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

      const parsed = await parseJsonBody(req);
      if (!parsed.ok) {
        jsonResponse(res, parsed.status, { error: parsed.error });
        return;
      }
      const body = parsed.body;

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
