#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVBRAIN_DIR = path.join(os.homedir(), '.devbrain');
const HOOKS_DIR = path.join(DEVBRAIN_DIR, 'hooks');
const SESSIONS_DIR = path.join(DEVBRAIN_DIR, 'sessions');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const HOOK_FILES = [
  'devbrain-session-start.js',
  'devbrain-inject.js',
  'devbrain-post-tool.js',
  'devbrain-session-end.js',
];

// Source: from compiled dist/src/hooks/ (npm tarball) or src/hooks/ (checkout).
// When running from dist/bin/, __dirname is dist/bin → ../src/hooks is the
// copy shipped by `npm run build` (scripts/copy-hooks.js), included in the
// npm tarball. When running from bin/ (ts-node/dev), the same relative path
// resolves to the project-root src/hooks.
function findHookSource(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'src', 'hooks'),       // dist/src/hooks, or src/hooks in dev
    path.resolve(__dirname, '..', '..', 'src', 'hooks'), // repo-root src/hooks from dist/bin
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not find hook scripts. Tried: ${candidates.join(', ')}. Run \`npm run build\` first.`,
  );
}

interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

function readClaudeSettings(): ClaudeSettings {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeClaudeSettings(settings: ClaudeSettings): void {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function makeHookEntry(scriptName: string): Record<string, unknown> {
  return {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `node ${path.join(HOOKS_DIR, scriptName)}`,
    }],
  };
}

const HOOK_EVENT_MAP: Record<string, string> = {
  'devbrain-session-start.js': 'user-prompt-submit',
  'devbrain-inject.js': 'user-prompt-submit',
  'devbrain-post-tool.js': 'PostToolUse',
  'devbrain-session-end.js': 'Stop',
};

function isDevBrainHook(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h: unknown) => {
    if (typeof h !== 'object' || h === null) return false;
    const cmd = (h as Record<string, unknown>).command;
    return typeof cmd === 'string' && cmd.includes('devbrain-');
  });
}

interface InstallOptions {
  readonly port: number;
  readonly force: boolean;
}

function parseArgs(): InstallOptions {
  const args = process.argv.slice(2);
  let port = 7384;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--force') {
      force = true;
    }
  }

  return { port, force };
}

function install(): void {
  const { port, force } = parseArgs();

  console.log('DevBrain Hook Installer');
  console.log('=======================\n');

  // 1. Create directories
  for (const dir of [HOOKS_DIR, SESSIONS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  Created: ${dir}`);
    }
  }

  // 2. Copy hook scripts
  const source = findHookSource();
  let copied = 0;
  for (const file of HOOK_FILES) {
    const src = path.join(source, file);
    const dst = path.join(HOOKS_DIR, file);

    if (!fs.existsSync(src)) {
      console.warn(`  Warning: ${file} not found at ${src}`);
      continue;
    }

    if (fs.existsSync(dst) && !force) {
      console.log(`  Skipped: ${file} (already exists, use --force to overwrite)`);
      continue;
    }

    // Read source, inject port if needed
    let content = fs.readFileSync(src, 'utf-8');
    if (port !== 7384) {
      content = content.replace(
        /const HOOK_PORT = process\.env\.DEVBRAIN_HOOK_PORT \|\| '7384'/,
        `const HOOK_PORT = process.env.DEVBRAIN_HOOK_PORT || '${port}'`
      );
    }

    fs.writeFileSync(dst, content, { mode: 0o755 });
    copied++;
    console.log(`  Installed: ${dst}`);
  }

  // 3. Merge into Claude settings.json
  const settings = readClaudeSettings();
  const hooks: Record<string, unknown[]> = (settings.hooks as Record<string, unknown[]>) ?? {};
  let merged = 0;

  for (const [scriptName, eventName] of Object.entries(HOOK_EVENT_MAP)) {
    const eventHooks = hooks[eventName] ?? [];

    // Check if our hook already exists
    const alreadyExists = eventHooks.some(isDevBrainHook);
    if (alreadyExists && !force) {
      console.log(`  Skipped: ${eventName} hook (already configured, use --force)`);
      continue;
    }

    // Remove existing devbrain hooks if force
    const cleaned = alreadyExists
      ? eventHooks.filter(e => !isDevBrainHook(e))
      : eventHooks;

    // Add our hook
    cleaned.push(makeHookEntry(scriptName));
    hooks[eventName] = cleaned;
    merged++;
    console.log(`  Configured: ${eventName} → ${scriptName}`);
  }

  if (merged > 0) {
    const updatedSettings: ClaudeSettings = { ...settings, hooks };
    writeClaudeSettings(updatedSettings);
    console.log(`\n  Updated: ${CLAUDE_SETTINGS_PATH}`);
  }

  // 4. Summary
  console.log('\n--- Summary ---');
  console.log(`  Hook scripts: ${copied} installed`);
  console.log(`  Claude settings: ${merged} hooks configured`);
  console.log(`  Hook server port: ${port}`);
  console.log(`  Sessions dir: ${SESSIONS_DIR}`);

  if (copied > 0 || merged > 0) {
    console.log('\n  DevBrain hooks are ready. Restart Claude Code to activate.');
  } else {
    console.log('\n  Nothing to do. All hooks already installed.');
  }
}

install();
