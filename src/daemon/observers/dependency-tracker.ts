import fs from 'node:fs';
import path from 'node:path';
import type { DirectDbWriter } from '../db-writer.js';
import type { WriteQueue } from '../write-queue.js';
import type { DaemonConfig, DependencyChange } from '../types.js';
import { daemonMeta } from '../types.js';

type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies';
const DEP_SECTIONS: readonly DepSection[] = ['dependencies', 'devDependencies', 'peerDependencies'];

export class DependencyTracker {
  private watcher: import('chokidar').FSWatcher | null = null;
  private previousDeps: Map<DepSection, Record<string, string>> = new Map();
  private readonly projectId: string;
  private readonly projectPath: string;
  private readonly writer: DirectDbWriter;
  private readonly writeQueue: WriteQueue;
  private readonly packageFiles: string[];

  constructor(opts: {
    projectId: string;
    projectPath: string;
    writer: DirectDbWriter;
    writeQueue: WriteQueue;
    config: DaemonConfig;
  }) {
    this.projectId = opts.projectId;
    this.projectPath = opts.projectPath;
    this.writer = opts.writer;
    this.writeQueue = opts.writeQueue;
    this.packageFiles = opts.config.packageFiles;
  }

  async start(): Promise<void> {
    // Snapshot current deps
    this.loadCurrentDeps();

    const watchPaths = this.packageFiles
      .map(f => path.join(this.projectPath, f))
      .filter(p => fs.existsSync(p));

    if (watchPaths.length === 0) return;

    const { watch } = await import('chokidar');
    this.watcher = watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('change', (filePath: string) => void this.handleChange(filePath));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private loadCurrentDeps(): void {
    const pkgPath = path.join(this.projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;

      for (const section of DEP_SECTIONS) {
        const deps = pkg[section];
        if (typeof deps === 'object' && deps !== null && !Array.isArray(deps)) {
          this.previousDeps.set(section, { ...(deps as Record<string, string>) });
        } else {
          this.previousDeps.set(section, {});
        }
      }
    } catch { /* ignore parse errors */ }
  }

  private async handleChange(filePath: string): Promise<void> {
    // Currently only handle package.json
    if (!filePath.endsWith('package.json')) return;

    let pkg: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const allChanges: DependencyChange[] = [];

    for (const section of DEP_SECTIONS) {
      const prev = this.previousDeps.get(section) ?? {};
      const next = (typeof pkg[section] === 'object' && pkg[section] !== null && !Array.isArray(pkg[section]))
        ? { ...(pkg[section] as Record<string, string>) }
        : {};

      const changes = diffDeps(prev, next, section);
      allChanges.push(...changes);

      this.previousDeps.set(section, next);
    }

    if (allChanges.length === 0) return;

    await this.writeQueue.enqueue(async () => {
      for (const change of allChanges) {
        if (change.type === 'added' || change.type === 'updated') {
          // Upsert dependency entity
          const name = `dep:${change.name}`;
          let entity = this.writer.store.findEntitiesByName(name, this.projectId)[0] ?? null;

          if (!entity) {
            entity = this.writer.store.addEntity({
              name,
              type: 'dependency',
              projectId: this.projectId,
              content: `${change.name}@${change.newVersion} (${change.section})`,
              metadata: daemonMeta({
                version: change.newVersion,
                section: change.section,
                changeType: change.type,
              }),
            });
          } else {
            this.writer.store.updateEntity(entity.id, {
              content: `${change.name}@${change.newVersion} (${change.section})`,
              metadata: daemonMeta({
                version: change.newVersion,
                section: change.section,
                changeType: change.type,
                previousVersion: change.previousVersion,
              }),
            });
          }

          // Add observation
          this.writer.store.addObservation({
            entityId: entity.id,
            content: change.type === 'added'
              ? `Added ${change.name}@${change.newVersion} to ${change.section}`
              : `Updated ${change.name} from ${change.previousVersion} to ${change.newVersion}`,
            source: 'dependency-tracker',
            category: 'dependency_change',
          });
        } else if (change.type === 'removed') {
          const entities = this.writer.store.findEntitiesByName(`dep:${change.name}`, this.projectId);
          if (entities.length > 0) {
            this.writer.store.updateEntity(entities[0].id, {
              status: 'removed',
              metadata: daemonMeta({ changeType: 'removed', section: change.section }),
            });
            this.writer.store.addObservation({
              entityId: entities[0].id,
              content: `Removed ${change.name} from ${change.section}`,
              source: 'dependency-tracker',
              category: 'dependency_change',
            });
          }
        }
      }
    });
  }
}

/** Pure function: diff two dependency records (immutable) */
export function diffDeps(
  prev: Record<string, string>,
  next: Record<string, string>,
  section: DepSection,
): DependencyChange[] {
  const changes: DependencyChange[] = [];

  for (const [name, version] of Object.entries(next)) {
    if (!(name in prev)) {
      changes.push({ name, type: 'added', section, previousVersion: null, newVersion: version });
    } else if (prev[name] !== version) {
      changes.push({ name, type: 'updated', section, previousVersion: prev[name], newVersion: version });
    }
  }

  for (const name of Object.keys(prev)) {
    if (!(name in next)) {
      changes.push({ name, type: 'removed', section, previousVersion: prev[name], newVersion: null });
    }
  }

  return changes;
}
