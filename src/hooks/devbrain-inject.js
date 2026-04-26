#!/usr/bin/env node
// DevBrain hook: user-prompt-submit (per-message context injection)
// Runs the injector pipeline directly (no HTTP server needed).
// Reads prompt from stdin JSON, returns additionalContext on stdout.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEVBRAIN_DIR = join(homedir(), '.devbrain');
const SESSION_FILE = join(DEVBRAIN_DIR, 'sessions', 'current.json');
const TIMEOUT_MS = 450; // slightly above pipeline timeout for overhead

async function main() {
  // Read stdin (Claude Code sends JSON with hook event data)
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

  const prompt = input?.prompt ?? input?.userPrompt ?? '';
  if (!prompt || typeof prompt !== 'string') {
    process.exit(0);
  }

  // Read session turns from current.json
  let sessionTurns = 0;
  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
    sessionTurns = session.turns ?? 0;
  } catch {
    // No session file — proceed with 0 turns
  }

  // Run injection pipeline with timeout
  const timer = setTimeout(() => process.exit(0), TIMEOUT_MS);
  try {
    // Dynamic import to handle cases where the module isn't built
    const { injectContext } = await import('../dist/injector/index.js');
    const result = await injectContext(prompt, sessionTurns);

    clearTimeout(timer);

    if (result.skipped || !result.context) {
      process.exit(0);
    }

    // Output context for Claude Code
    const output = {
      hookSpecificOutput: {
        additionalContext: result.context,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch {
    clearTimeout(timer);
    // Silently exit — never block Claude
  }
}

main().catch(() => process.exit(0));
