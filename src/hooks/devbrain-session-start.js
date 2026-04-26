#!/usr/bin/env node
// DevBrain hook: user-prompt-submit (session start)
// Reads stdin JSON from Claude Code, sends cwd to DevBrain hook server.
// Returns context as additionalContext for prompt injection.
// Also generates ~/.claude/rules/devbrain-project-context.md (permanent layer).

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOOK_PORT = process.env.DEVBRAIN_HOOK_PORT || '7384';
const BASE_URL = `http://127.0.0.1:${HOOK_PORT}`;
const TIMEOUT_MS = 3000;
const RULES_DIR = join(homedir(), '.claude', 'rules');
const RULES_FILE = join(RULES_DIR, 'devbrain-project-context.md');

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
    input = {};
  }

  const cwd = input.cwd || process.cwd();

  // Generate permanent rules file (best-effort, non-blocking)
  await generateRulesFileAsync();

  // Health check first
  try {
    const healthRes = await fetchWithTimeout(`${BASE_URL}/health`, {
      method: 'GET',
    });
    if (!healthRes.ok) {
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }

  // Call session-start
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/hook/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });

    const result = await res.json();

    if (result.ok && result.context) {
      const output = {
        hookSpecificOutput: {
          additionalContext: `[DevBrain] Project: ${result.projectName || 'unknown'} | Session: ${result.sessionId}\n\n${result.context}`,
        },
      };
      process.stdout.write(JSON.stringify(output));
    }
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

async function generateRulesFileAsync() {
  try {
    const mod = await import('../dist/injector/index.js');
    const content = mod.generateRulesFile();
    if (content) {
      if (!existsSync(RULES_DIR)) mkdirSync(RULES_DIR, { recursive: true });
      writeFileSync(RULES_FILE, content, 'utf-8');
    }
  } catch {
    // Best-effort — don't block on rules file generation failure
  }
}

main().catch(() => process.exit(0));
