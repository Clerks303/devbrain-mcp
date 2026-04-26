#!/usr/bin/env node
// DevBrain hook: Stop (session end)
// Reads current session from ~/.devbrain/sessions/current.json
// and sends end_session to the hook server.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOOK_PORT = process.env.DEVBRAIN_HOOK_PORT || '7384';
const BASE_URL = `http://127.0.0.1:${HOOK_PORT}`;
const TIMEOUT_MS = 5000; // More time for summary generation
const CURRENT_SESSION_PATH = join(homedir(), '.devbrain', 'sessions', 'current.json');

async function main() {
  // Read current session info
  let sessionId = null;
  try {
    if (existsSync(CURRENT_SESSION_PATH)) {
      const raw = readFileSync(CURRENT_SESSION_PATH, 'utf-8');
      const current = JSON.parse(raw);
      sessionId = current.sessionId;
    }
  } catch {
    // No current session file
  }

  // Also try stdin
  if (!sessionId) {
    try {
      const chunks = [];
      // Set a short timeout for stdin reading
      const stdinTimeout = setTimeout(() => {
        process.stdin.destroy();
      }, 500);
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      clearTimeout(stdinTimeout);
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw) {
        const input = JSON.parse(raw);
        sessionId = input.session_id || input.sessionId;
      }
    } catch {
      // No stdin data
    }
  }

  if (!sessionId) process.exit(0);

  // Call session-end
  try {
    await fetchWithTimeout(`${BASE_URL}/api/hook/session-end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch {
    // Silently exit — never block Claude shutdown
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(() => process.exit(0));
