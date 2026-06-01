import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { KnowledgeStore } from '../../src/db/store.js';
import { VectorStore } from '../../src/db/vector.js';
import { registerEntityTools } from '../../src/tools/entities.js';
import { registerRelationTools } from '../../src/tools/relations.js';
import { registerObservationTools } from '../../src/tools/observations.js';
import { registerIssueTools } from '../../src/tools/issues.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

const DIM = 8;

/**
 * The MCP tool registrars only ever call `server.tool(name, desc, schema, handler)`.
 * We pass a fake server that captures the handlers, so we can invoke a tool exactly
 * the way the MCP SDK would and assert on its `{ isError: true }` contract — without
 * standing up a real stdio transport.
 */
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureHandlers(
  register: (server: unknown, brain: unknown) => void,
  brain: unknown,
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  };
  register(fakeServer, brain);
  return handlers;
}

const fakeProvider: EmbeddingProvider = {
  dimension: DIM,
  name: 'fake',
  embed: async () => new Array(DIM).fill(0),
  embedBatch: async (texts: string[]) => texts.map(() => new Array(DIM).fill(0)),
};

interface Ctx {
  db: Database.Database;
  brain: {
    store: KnowledgeStore;
    vectorStore: VectorStore;
    embeddingProvider: EmbeddingProvider;
    activeProjectId: string | null;
    activeSessionId: string | null;
  };
}

function setup(): Ctx {
  const db = initDatabase(':memory:', DIM);
  const store = new KnowledgeStore(db);
  const vectorStore = new VectorStore(db);
  const project = store.addProject({ name: 'errpaths', path: '/tmp/errpaths' });
  return {
    db,
    brain: {
      store,
      vectorStore,
      embeddingProvider: fakeProvider,
      activeProjectId: project.id,
      activeSessionId: null,
    },
  };
}

describe('MCP tool error paths (isError contract)', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('devbrain_delete_entity returns isError for a non-existent entity', async () => {
    const handlers = captureHandlers(registerEntityTools as never, ctx.brain);
    const result = await handlers['devbrain_delete_entity']({ id: 'does-not-exist' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Entity not found');
  });

  it('devbrain_add_relation returns isError when source or target entity is missing', async () => {
    const handlers = captureHandlers(registerRelationTools as never, ctx.brain);

    // Source missing
    const missingSource = await handlers['devbrain_add_relation']({
      from_entity_id: 'ghost',
      to_entity_id: 'also-ghost',
      type: 'depends_on',
    });
    expect(missingSource.isError).toBe(true);
    expect(missingSource.content[0].text).toContain('Source entity not found');

    // Source exists, target missing
    const real = ctx.brain.store.addEntity({
      name: 'realEntity',
      type: 'module',
      projectId: ctx.brain.activeProjectId,
    });
    const missingTarget = await handlers['devbrain_add_relation']({
      from_entity_id: real.id,
      to_entity_id: 'still-ghost',
      type: 'depends_on',
    });
    expect(missingTarget.isError).toBe(true);
    expect(missingTarget.content[0].text).toContain('Target entity not found');
  });

  it('devbrain_add_observation returns isError for a non-existent entity', async () => {
    const handlers = captureHandlers(registerObservationTools as never, ctx.brain);
    const result = await handlers['devbrain_add_observation']({
      entity_id: 'nope',
      content: 'orphan observation',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Entity not found');
  });

  it('devbrain_get_issue returns isError for a non-existent issue', async () => {
    const handlers = captureHandlers(registerIssueTools as never, ctx.brain);
    const result = await handlers['devbrain_get_issue']({ id: 'no-such-issue' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Issue not found');
  });

  it('a valid delete_entity does NOT set isError (happy-path contrast)', async () => {
    const handlers = captureHandlers(registerEntityTools as never, ctx.brain);
    const entity = ctx.brain.store.addEntity({
      name: 'toDelete',
      type: 'module',
      projectId: ctx.brain.activeProjectId,
    });

    const result = await handlers['devbrain_delete_entity']({ id: entity.id });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Deleted entity');
    expect(ctx.brain.store.getEntity(entity.id)).toBeNull();
  });
});
