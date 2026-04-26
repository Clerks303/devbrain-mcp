#!/usr/bin/env node
// DevBrain hook: PostToolUse
// Logs tool calls and auto-digests files after Write/Edit.
// Must execute in < 100ms — all heavy work delegated to server.

const HOOK_PORT = process.env.DEVBRAIN_HOOK_PORT || '7384';
const BASE_URL = `http://127.0.0.1:${HOOK_PORT}`;
const TIMEOUT_MS = 2000;

async function main() {
  // Read stdin (Claude Code sends tool event JSON)
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || input.toolName;
  if (!toolName) process.exit(0);

  // Send to hook server (fire and forget — don't wait for response)
  try {
    await fetchWithTimeout(`${BASE_URL}/api/hook/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: toolName,
        tool_input: input.tool_input || input.input || {},
        tool_output: input.tool_output || input.output || null,
        cwd: input.cwd || process.cwd(),
      }),
    });
  } catch {
    // Silently exit — never block Claude
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
