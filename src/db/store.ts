import type Database from 'better-sqlite3';
import type {
  Entity, Relation, Observation, Project, GraphSummary, FileDigest,
  StalenessResult, Issue, Session, SessionEvent, Rule, Lesson, Snapshot,
} from '../types.js';
import type { Page } from './pagination.js';
import { EntityRepository } from './repositories/entity-repository.js';
import { RelationRepository } from './repositories/relation-repository.js';
import { ObservationRepository } from './repositories/observation-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { FileDigestRepository } from './repositories/file-digest-repository.js';
import { IssueRepository } from './repositories/issue-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { RuleRepository } from './repositories/rule-repository.js';
import { LessonRepository } from './repositories/lesson-repository.js';
import { SummaryRepository } from './repositories/summary-repository.js';
import { SnapshotRepository } from './repositories/snapshot-repository.js';

/**
 * Façade over per-aggregate repositories. Each repository owns one slice of
 * the schema (entities, issues, sessions, …) and a single `db` round-trip per
 * method. KnowledgeStore composes them and exposes a flat, stable API so the
 * ~70 MCP tool handlers and tests don't depend on the internal split.
 */
export class KnowledgeStore {
  private readonly entities: EntityRepository;
  private readonly relations: RelationRepository;
  private readonly observations: ObservationRepository;
  private readonly projects: ProjectRepository;
  private readonly fileDigests: FileDigestRepository;
  private readonly issues: IssueRepository;
  private readonly sessions: SessionRepository;
  private readonly rules: RuleRepository;
  private readonly lessons: LessonRepository;
  private readonly summary: SummaryRepository;
  private readonly snapshots: SnapshotRepository;

  constructor(private db: Database.Database) {
    this.entities = new EntityRepository(db);
    this.relations = new RelationRepository(db);
    this.observations = new ObservationRepository(db);
    this.projects = new ProjectRepository(db);
    this.fileDigests = new FileDigestRepository(db);
    this.issues = new IssueRepository(db);
    this.sessions = new SessionRepository(db);
    this.rules = new RuleRepository(db);
    this.lessons = new LessonRepository(db);
    this.summary = new SummaryRepository(db);
    this.snapshots = new SnapshotRepository(db, {
      fileDigests: this.fileDigests,
      issues: this.issues,
      rules: this.rules,
      lessons: this.lessons,
    });
  }

  // --- Entities ---

  addEntity(params: Parameters<EntityRepository['addEntity']>[0]): Entity {
    return this.entities.addEntity(params);
  }
  getEntity(id: string): Entity | null {
    return this.entities.getEntity(id);
  }
  updateEntity(id: string, updates: Parameters<EntityRepository['updateEntity']>[1]): Entity {
    return this.entities.updateEntity(id, updates);
  }
  deleteEntity(id: string): void {
    this.entities.deleteEntity(id);
  }
  getEntitiesByIds(
    ids: readonly string[],
    filters?: { projectId?: string | null; types?: readonly string[] },
  ): Entity[] {
    return this.entities.getEntitiesByIds(ids, filters);
  }
  listEntities(projectId?: string | null, type?: string, limit?: number, offset?: number): Entity[] {
    return this.entities.listEntities(projectId, type, limit, offset);
  }
  findEntitiesByName(name: string, projectId?: string | null): Entity[] {
    return this.entities.findEntitiesByName(name, projectId);
  }
  listEntitiesPage(
    projectId: string | null | undefined,
    opts?: { type?: string; limit?: number; cursor?: string | null },
  ): Page<Entity> {
    return this.entities.listEntitiesPage(projectId, opts);
  }

  // --- Relations ---

  addRelation(params: Parameters<RelationRepository['addRelation']>[0]): Relation {
    return this.relations.addRelation(params);
  }
  getRelation(id: string): Relation | null {
    return this.relations.getRelation(id);
  }
  getRelations(entityId: string, direction?: 'from' | 'to' | 'both'): Relation[] {
    return this.relations.getRelations(entityId, direction);
  }
  deleteRelation(id: string): void {
    this.relations.deleteRelation(id);
  }

  // --- Observations ---

  addObservation(params: Parameters<ObservationRepository['addObservation']>[0]): Observation {
    return this.observations.addObservation(params);
  }
  getObservation(id: string): Observation | null {
    return this.observations.getObservation(id);
  }
  getObservations(entityId: string): Observation[] {
    return this.observations.getObservations(entityId);
  }
  deleteObservation(id: string): void {
    this.observations.deleteObservation(id);
  }
  getObservationsGroupedByEntityIds(entityIds: readonly string[]): Map<string, Observation[]> {
    return this.observations.getObservationsGroupedByEntityIds(entityIds);
  }
  getObservationEntityIds(ids: readonly string[]): Map<string, string> {
    return this.observations.getObservationEntityIds(ids);
  }

  // --- Projects ---

  addProject(params: Parameters<ProjectRepository['addProject']>[0]): Project {
    return this.projects.addProject(params);
  }
  getProject(id: string): Project | null {
    return this.projects.getProject(id);
  }
  getProjectByPath(projectPath: string): Project | null {
    return this.projects.getProjectByPath(projectPath);
  }
  listProjects(limit?: number, offset?: number): Project[] {
    return this.projects.listProjects(limit, offset);
  }

  // --- Summary ---

  getGraphSummary(projectId?: string | null): GraphSummary {
    return this.summary.getGraphSummary(projectId);
  }

  // --- File Digests ---

  upsertFileDigest(params: Parameters<FileDigestRepository['upsertFileDigest']>[0]): FileDigest {
    return this.fileDigests.upsertFileDigest(params);
  }
  getFileDigest(id: string): FileDigest | null {
    return this.fileDigests.getFileDigest(id);
  }
  getFileDigestByPath(projectId: string, filePath: string): FileDigest | null {
    return this.fileDigests.getFileDigestByPath(projectId, filePath);
  }
  listFileDigests(projectId: string, filters?: { status?: string; language?: string; limit?: number; offset?: number }): FileDigest[] {
    return this.fileDigests.listFileDigests(projectId, filters);
  }
  checkFilesStaleness(projectId: string, files: { path: string; hash: string }[]): StalenessResult[] {
    return this.fileDigests.checkFilesStaleness(projectId, files);
  }
  deleteFileDigest(id: string): void {
    this.fileDigests.deleteFileDigest(id);
  }

  // --- Issues ---

  addIssue(params: Parameters<IssueRepository['addIssue']>[0]): Issue {
    return this.issues.addIssue(params);
  }
  getIssue(id: string): Issue | null {
    return this.issues.getIssue(id);
  }
  updateIssue(id: string, updates: Parameters<IssueRepository['updateIssue']>[1]): Issue {
    return this.issues.updateIssue(id, updates);
  }
  listIssues(projectId: string, filters?: Parameters<IssueRepository['listIssues']>[1]): Issue[] {
    return this.issues.listIssues(projectId, filters);
  }
  getIssueEntityIds(ids: readonly string[]): Map<string, string | null> {
    return this.issues.getIssueEntityIds(ids);
  }
  deleteIssue(id: string): void {
    this.issues.deleteIssue(id);
  }
  listIssuesPage(projectId: string, opts?: Parameters<IssueRepository['listIssuesPage']>[1]): Page<Issue> {
    return this.issues.listIssuesPage(projectId, opts);
  }

  // --- Database accessor ---

  getDb(): Database.Database {
    return this.db;
  }

  // --- Sessions ---

  startSession(params: { projectId: string; goal: string }): Session {
    return this.sessions.startSession(params);
  }
  endSession(id: string, summary?: string): Session {
    return this.sessions.endSession(id, summary);
  }
  updateSessionCounters(id: string, increments: { toolCalls?: number; entitiesModified?: number }): void {
    this.sessions.updateSessionCounters(id, increments);
  }
  addSessionEvent(params: Parameters<SessionRepository['addSessionEvent']>[0]): SessionEvent {
    return this.sessions.addSessionEvent(params);
  }
  getSessionEvent(id: string): SessionEvent | null {
    return this.sessions.getSessionEvent(id);
  }
  getSession(id: string): Session | null {
    return this.sessions.getSession(id);
  }
  listSessions(projectId: string, limit?: number, offset?: number): Session[] {
    return this.sessions.listSessions(projectId, limit, offset);
  }
  getSessionEvents(sessionId: string): SessionEvent[] {
    return this.sessions.getSessionEvents(sessionId);
  }
  getLastSession(projectId: string): Session | null {
    return this.sessions.getLastSession(projectId);
  }

  // --- Rules ---

  addRule(params: Parameters<RuleRepository['addRule']>[0]): Rule {
    return this.rules.addRule(params);
  }
  getRule(id: string): Rule | null {
    return this.rules.getRule(id);
  }
  updateRule(id: string, updates: Parameters<RuleRepository['updateRule']>[1]): Rule {
    return this.rules.updateRule(id, updates);
  }
  listRules(projectId: string, scope?: Rule['scope'], limit?: number, offset?: number): Rule[] {
    return this.rules.listRules(projectId, scope, limit, offset);
  }
  matchRules(projectId: string, context: { filePath?: string; entityType?: string }): Rule[] {
    return this.rules.matchRules(projectId, context);
  }
  deleteRule(id: string): void {
    this.rules.deleteRule(id);
  }

  // --- Lessons ---

  addLesson(params: Parameters<LessonRepository['addLesson']>[0]): Lesson {
    return this.lessons.addLesson(params);
  }
  getLesson(id: string): Lesson | null {
    return this.lessons.getLesson(id);
  }
  updateLesson(id: string, updates: Parameters<LessonRepository['updateLesson']>[1]): Lesson {
    return this.lessons.updateLesson(id, updates);
  }
  reinforceLesson(id: string): Lesson {
    return this.lessons.reinforceLesson(id);
  }
  listLessons(projectId: string, filters?: Parameters<LessonRepository['listLessons']>[1]): Lesson[] {
    return this.lessons.listLessons(projectId, filters);
  }
  deleteLesson(id: string): void {
    this.lessons.deleteLesson(id);
  }

  // --- Snapshots ---

  createSnapshot(projectId: string, label: string, description?: string | null): Snapshot {
    return this.snapshots.createSnapshot(projectId, label, description);
  }
  getSnapshot(id: string): Snapshot | null {
    return this.snapshots.getSnapshot(id);
  }
  listSnapshots(projectId: string, limit?: number, offset?: number): Omit<Snapshot, 'data'>[] {
    return this.snapshots.listSnapshots(projectId, limit, offset);
  }
  deleteSnapshot(id: string): void {
    this.snapshots.deleteSnapshot(id);
  }
  restoreSnapshot(projectId: string, snapshotId: string): Record<string, number> {
    return this.snapshots.restoreSnapshot(projectId, snapshotId);
  }
}
