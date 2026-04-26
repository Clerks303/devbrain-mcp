import { describe, it, expect } from 'vitest';
import { diffDeps } from '../../src/daemon/observers/dependency-tracker.js';

describe('diffDeps', () => {
  it('should detect added dependencies', () => {
    const prev = {};
    const next = { react: '^18.0.0', lodash: '^4.0.0' };
    const changes = diffDeps(prev, next, 'dependencies');

    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual({
      name: 'react',
      type: 'added',
      section: 'dependencies',
      previousVersion: null,
      newVersion: '^18.0.0',
    });
  });

  it('should detect removed dependencies', () => {
    const prev = { react: '^18.0.0', lodash: '^4.0.0' };
    const next = { react: '^18.0.0' };
    const changes = diffDeps(prev, next, 'dependencies');

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      name: 'lodash',
      type: 'removed',
      section: 'dependencies',
      previousVersion: '^4.0.0',
      newVersion: null,
    });
  });

  it('should detect updated dependencies', () => {
    const prev = { react: '^17.0.0' };
    const next = { react: '^18.0.0' };
    const changes = diffDeps(prev, next, 'dependencies');

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      name: 'react',
      type: 'updated',
      section: 'dependencies',
      previousVersion: '^17.0.0',
      newVersion: '^18.0.0',
    });
  });

  it('should return empty for identical deps', () => {
    const deps = { react: '^18.0.0', lodash: '^4.0.0' };
    const changes = diffDeps(deps, { ...deps }, 'dependencies');
    expect(changes).toHaveLength(0);
  });

  it('should handle mixed changes', () => {
    const prev = { react: '^17.0.0', lodash: '^4.0.0', express: '^4.0.0' };
    const next = { react: '^18.0.0', fastify: '^4.0.0', express: '^4.0.0' };
    const changes = diffDeps(prev, next, 'devDependencies');

    expect(changes).toHaveLength(3);
    const names = changes.map(c => `${c.type}:${c.name}`);
    expect(names).toContain('updated:react');
    expect(names).toContain('added:fastify');
    expect(names).toContain('removed:lodash');
    // All should have correct section
    expect(changes.every(c => c.section === 'devDependencies')).toBe(true);
  });

  it('should not mutate input objects', () => {
    const prev = { a: '1' };
    const next = { b: '2' };
    const prevCopy = { ...prev };
    const nextCopy = { ...next };
    diffDeps(prev, next, 'dependencies');
    expect(prev).toEqual(prevCopy);
    expect(next).toEqual(nextCopy);
  });
});
