import type { KnowledgeStore } from '../db/store.js';
import type { EntityContext } from '../types.js';

export function getEntityContext(store: KnowledgeStore, entityId: string): EntityContext | null {
  const entity = store.getEntity(entityId);
  if (!entity) return null;

  const outgoingRelations = store.getRelations(entityId, 'from');
  const incomingRelations = store.getRelations(entityId, 'to');
  const observations = store.getObservations(entityId);

  const outgoing = outgoingRelations.map(r => {
    const targetEntity = store.getEntity(r.toEntityId);
    return { ...r, targetEntity: targetEntity! };
  }).filter(r => r.targetEntity);

  const incoming = incomingRelations.map(r => {
    const sourceEntity = store.getEntity(r.fromEntityId);
    return { ...r, sourceEntity: sourceEntity! };
  }).filter(r => r.sourceEntity);

  return {
    entity,
    relations: { outgoing, incoming },
    observations,
  };
}
