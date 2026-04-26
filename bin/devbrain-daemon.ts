#!/usr/bin/env node
import { readPid, isDaemonRunning, removePid, getPidFilePath } from '../src/daemon/pid-manager.js';

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case 'start':
      await handleStart();
      break;
    case 'stop':
      handleStop();
      break;
    case 'status':
      handleStatus();
      break;
    case 'reload':
      handleReload();
      break;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function handleStart(): Promise<void> {
  if (isDaemonRunning()) {
    const pid = readPid();
    console.error(`DevBrain daemon already running (PID ${pid})`);
    process.exit(1);
  }

  const foreground = process.argv.includes('--foreground') || process.argv.includes('-f');

  if (foreground) {
    // Run in foreground (useful for debugging and development)
    const { startDaemon } = await import('../src/daemon/index.js');
    await startDaemon();
  } else {
    // Fork as background process
    const { fork } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const daemonScript = path.join(__dirname, '..', 'src', 'daemon', 'index.js');

    // Create a small wrapper that calls startDaemon
    const child = fork(daemonScript, ['--start'], {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    console.log(`DevBrain daemon started (PID ${child.pid})`);
  }
}

function handleStop(): void {
  const pid = readPid();
  if (pid === null || !isDaemonRunning()) {
    console.log('DevBrain daemon is not running');
    removePid();
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`DevBrain daemon stopped (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop daemon (PID ${pid}):`, err);
    removePid();
  }
}

function handleStatus(): void {
  const pid = readPid();
  if (isDaemonRunning()) {
    console.log(`DevBrain daemon: running (PID ${pid})`);
    console.log(`PID file: ${getPidFilePath()}`);
  } else {
    console.log('DevBrain daemon: stopped');
  }
}

function handleReload(): void {
  const pid = readPid();
  if (!isDaemonRunning()) {
    console.log('DevBrain daemon is not running');
    return;
  }

  try {
    process.kill(pid!, 'SIGHUP');
    console.log(`DevBrain daemon reloaded (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to reload daemon:`, err);
  }
}

function printUsage(): void {
  console.log(`
Usage: devbrain-daemon <command>

Commands:
  start [--foreground]  Start the daemon (background by default)
  stop                  Stop the daemon
  status                Show daemon status
  reload                Reload project list (SIGHUP)
`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
