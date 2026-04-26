import { describe, it, expect, afterEach } from 'vitest';
import { writePid, readPid, removePid, isDaemonRunning } from '../../src/daemon/pid-manager.js';

describe('PID Manager', () => {
  afterEach(() => {
    removePid();
  });

  it('should write and read PID', () => {
    writePid();
    const pid = readPid();
    expect(pid).toBe(process.pid);
  });

  it('should return null when no PID file exists', () => {
    removePid();
    expect(readPid()).toBeNull();
  });

  it('should detect current process as running', () => {
    writePid();
    expect(isDaemonRunning()).toBe(true);
  });

  it('should detect non-existent process as not running', () => {
    removePid();
    expect(isDaemonRunning()).toBe(false);
  });

  it('should clean up stale PID file', async () => {
    // Write a PID that doesn't correspond to any process
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { getPidFilePath } = await import('../../src/daemon/pid-manager.js');
    const pidFile = getPidFilePath();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, '999999999');

    expect(isDaemonRunning()).toBe(false);
    // PID file should be cleaned up
    expect(readPid()).toBeNull();
  });
});
