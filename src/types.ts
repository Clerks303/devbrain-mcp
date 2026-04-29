// --- Centralized enum constants ---
//
// Each of these `as const` arrays is the single source of truth for a string
// union. Tools (Zod schemas) and types both derive from the same array via
// `typeof X[number]`, so adding a value updates validation and types together.
// Don't redeclare these literal unions inline elsewhere.

export const ENTITY_STATUSES = ['active', 'deprecated', 'experimental', 'stable', 'unknown'] as const;
export type EntityStatus = typeof ENTITY_STATUSES[number];

export const FILE_STATUSES = ['active', 'deprecated', 'draft', 'deleted'] as const;
export type FileStatus = typeof FILE_STATUSES[number];

export const ISSUE_TYPES = ['bug', 'debt', 'todo', 'improvement'] as const;
export type IssueType = typeof ISSUE_TYPES[number];

export const ISSUE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type IssueSeverity = typeof ISSUE_SEVERITIES[number];

export const ISSUE_STATUSES = ['open', 'in_progress', 'resolved', 'wontfix'] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];

export const SESSION_EVENT_TYPES = ['tool_call', 'decision', 'discovery', 'error'] as const;
export type SessionEventType = typeof SESSION_EVENT_TYPES[number];

export const RULE_SCOPES = ['global', 'file_pattern', 'entity_type'] as const;
export type RuleScope = typeof RULE_SCOPES[number];

export const RULE_SEVERITIES = ['must', 'should', 'prefer'] as const;
export type RuleSeverity = typeof RULE_SEVERITIES[number];

export const LESSON_OUTCOMES = ['positive', 'negative', 'neutral'] as const;
export type LessonOutcome = typeof LESSON_OUTCOMES[number];

export const OBSERVATION_CATEGORIES = ['note', 'implementation', 'caveat', 'todo'] as const;
export type ObservationCategory = typeof OBSERVATION_CATEGORIES[number];

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

export interface Entity {
  id: string;
  name: string;
  type: string;
  projectId: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  weight: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Observation {
  id: string;
  entityId: string;
  content: string;
  source: string | null;
  category: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface FileDigest {
  id: string;
  projectId: string;
  path: string;
  contentHash: string | null;
  summary: string | null;
  exports: string[];
  imports: string[];
  language: string | null;
  loc: number | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface StalenessResult {
  path: string;
  currentHash: string | null;
  providedHash: string;
  isStale: boolean;
}

export interface Issue {
  id: string;
  projectId: string;
  entityId: string | null;
  filePath: string | null;
  type: string;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  resolution: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  goal: string;
  summary: string | null;
  toolCalls: number;
  entitiesModified: number;
  startedAt: string;
  endedAt: string | null;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  content: string;
  toolName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Rule {
  id: string;
  projectId: string;
  scope: RuleScope;
  pattern: string | null;
  content: string;
  severity: RuleSeverity;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lesson {
  id: string;
  projectId: string;
  trigger: string;
  action: string;
  outcome: LessonOutcome;
  confidence: number;
  occurrences: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  projectId: string;
  label: string;
  description: string | null;
  data: string;
  entityCount: number;
  relationCount: number;
  createdAt: string;
}

// --- Destination Layer (Phase 1 — Goals & Vision) ---

export interface VisionStackItem {
  layer: string;
  tech: string;
}

export interface ProjectVision {
  projectId: string;
  description: string | null;
  features: string[];
  stack: VisionStackItem[];
  constraints: string[];
  updatedAt: string;
}

export const GOAL_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type GoalPriority = typeof GOAL_PRIORITIES[number];

export const GOAL_STATUSES = ['not_started', 'in_progress', 'done', 'blocked'] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];

export const GOAL_ENTITY_ROLES = ['implements', 'blocks', 'depends_on', 'touches'] as const;
export type GoalEntityRole = typeof GOAL_ENTITY_ROLES[number];

export const GOAL_MISSION_OUTCOMES = ['success', 'partial', 'failed'] as const;
export type GoalMissionOutcome = typeof GOAL_MISSION_OUTCOMES[number];

export interface Goal {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: GoalPriority;
  status: GoalStatus;
  parentGoalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEntityLink {
  goalId: string;
  entityId: string;
  role: GoalEntityRole;
}

export interface GoalMission {
  goalId: string;
  missionId: string;
  outcome: GoalMissionOutcome | null;
  createdAt: string;
}

export interface SearchResult {
  id: string;
  distance: number;
}

export interface GraphSummary {
  entityCount: number;
  relationCount: number;
  observationCount: number;
  fileDigestCount: number;
  issueCount: number;
  openIssueCount: number;
  sessionCount: number;
  ruleCount: number;
  lessonCount: number;
  topEntities: { name: string; type: string; relationCount: number }[];
  entityTypes: Record<string, number>;
}

export interface EntityContext {
  entity: Entity;
  relations: {
    outgoing: (Relation & { targetEntity: Entity })[];
    incoming: (Relation & { sourceEntity: Entity })[];
  };
  observations: Observation[];
}

export interface TraversalNode {
  entity: Entity;
  depth: number;
  path: string[];
  relations: Relation[];
}

export interface HybridSearchResult {
  entity: Entity;
  score: number;
  matchType: 'vector' | 'graph' | 'both';
  observations: Observation[];
}
