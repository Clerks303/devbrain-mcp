import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PID_FILE = path.join(os.homedir(), '.devbrain', 'daemon.pid');

export function writePid(): void {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

export function readPid(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function removePid(): void {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 = test existence without killing
    return true;
  } catch {
    // Process doesn't exist — stale PID file
    removePid();
    return false;
  }
}

export function getPidFilePath(): string {
  return PID_FILE;
}
