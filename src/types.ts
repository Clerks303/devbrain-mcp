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
  type: 'tool_call' | 'decision' | 'discovery' | 'error';
  content: string;
  toolName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Rule {
  id: string;
  projectId: string;
  scope: 'global' | 'file_pattern' | 'entity_type';
  pattern: string | null;
  content: string;
  severity: 'must' | 'should' | 'prefer';
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lesson {
  id: string;
  projectId: string;
  trigger: string;
  action: string;
  outcome: 'positive' | 'negative' | 'neutral';
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

export type GoalPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type GoalStatus = 'not_started' | 'in_progress' | 'done' | 'blocked';
export type GoalEntityRole = 'implements' | 'blocks' | 'depends_on' | 'touches';
export type GoalMissionOutcome = 'success' | 'partial' | 'failed';

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
