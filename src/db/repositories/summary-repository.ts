import type Database from 'better-sqlite3';
import type { GraphSummary } from '../../types.js';

export class SummaryRepository {
  constructor(private db: Database.Database) {}

  getGraphSummary(projectId?: string | null): GraphSummary {
    const entityFilter = projectId
      ? 'WHERE project_id = ? OR project_id IS NULL'
      : '';
    const entityParams = projectId ? [projectId] : [];

    const entityCount = (this.db.prepare(
      `SELECT COUNT(*) as c FROM entities ${entityFilter}`
    ).get(...entityParams) as { c: number }).c;

    const relationCount = (this.db.prepare(`
      SELECT COUNT(*) as c FROM relations
      ${projectId ? 'WHERE from_entity_id IN (SELECT id FROM entities WHERE project_id = ? OR project_id IS NULL)' : ''}
    `).get(...entityParams) as { c: number }).c;

    const observationCount = (this.db.prepare(`
      SELECT COUNT(*) as c FROM observations
      ${projectId ? 'WHERE entity_id IN (SELECT id FROM entities WHERE project_id = ? OR project_id IS NULL)' : ''}
    `).get(...entityParams) as { c: number }).c;

    const topEntities = (this.db.prepare(`
      SELECT e.name, e.type, COUNT(r.id) as relation_count
      FROM entities e
      LEFT JOIN relations r ON r.from_entity_id = e.id OR r.to_entity_id = e.id
      ${projectId ? 'WHERE (e.project_id = ? OR e.project_id IS NULL)' : ''}
      GROUP BY e.id
      ORDER BY relation_count DESC
      LIMIT 10
    `).all(...entityParams) as { name: string; type: string; relation_count: number }[])
      .map(r => ({ name: r.name, type: r.type, relationCount: r.relation_count }));

    const typeRows = this.db.prepare(`
      SELECT type, COUNT(*) as c FROM entities
      ${entityFilter}
      GROUP BY type
    `).all(...entityParams) as { type: string; c: number }[];

    const entityTypes: Record<string, number> = {};
    for (const row of typeRows) {
      entityTypes[row.type] = row.c;
    }

    const fileDigestCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM file_digests ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const issueCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM issues ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const openIssueCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM issues WHERE status = 'open' ${projectId ? 'AND project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const sessionCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM sessions ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const ruleCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM rules ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    const lessonCount = (() => {
      try {
        return (this.db.prepare(
          `SELECT COUNT(*) as c FROM lessons ${projectId ? 'WHERE project_id = ?' : ''}`
        ).get(...entityParams) as { c: number }).c;
      } catch { return 0; }
    })();

    return { entityCount, relationCount, observationCount, fileDigestCount, issueCount, openIssueCount, sessionCount, ruleCount, lessonCount, topEntities, entityTypes };
  }
}
