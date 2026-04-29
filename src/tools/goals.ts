import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import {
  createGoal,
  deleteGoal,
  getGoal,
  getGoalDelta,
  getGoalEntities,
  getGoalMissions,
  getProjectVision,
  linkGoalEntity,
  listGoals,
  recordGoalMission,
  setProjectVision,
  unlinkGoalEntity,
  updateGoalStatus,
} from '../db/goals-store.js';
import {
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  GOAL_ENTITY_ROLES,
  GOAL_MISSION_OUTCOMES,
  type Goal,
  type GoalPriority,
  type GoalStatus,
} from '../types.js';
import { generateMissionContext } from '../graph/mission-context.js';

const priorityEnum = z.enum(GOAL_PRIORITIES);
const statusEnum = z.enum(GOAL_STATUSES);
const roleEnum = z.enum(GOAL_ENTITY_ROLES);

function requireActiveProject(brain: DevBrain, projectId?: string | null): string | null {
  return projectId ?? brain.activeProjectId;
}

interface ScoredGoal {
  goal: Goal;
  score: number;
  reason: string;
}

function scoreGoalForNextAction(
  goal: Goal,
  parentDone: boolean,
  hasEntities: boolean,
  hasLessons: boolean,
): ScoredGoal {
  const reasons: string[] = [];
  let score = 0;

  // Priority weight
  if (goal.priority === 'P0') { score += 3; reasons.push('P0 priority'); }
  else if (goal.priority === 'P1') { score += 2; reasons.push('P1 priority'); }
  else if (goal.priority === 'P2') { score += 1; }

  // In-progress bonus
  if (goal.status === 'in_progress') {
    score += 2;
    reasons.push('already in progress');
  }

  // Dependency block penalty
  if (goal.parentGoalId && !parentDone) {
    score -= 2;
    reasons.push('parent goal not done');
  }

  // Scope clarity
  if (hasEntities) {
    score += 1;
    reasons.push('scope is defined');
  }

  // Prior knowledge
  if (hasLessons) {
    score += 1;
    reasons.push('relevant lessons available');
  }

  return { goal, score, reason: reasons.join(', ') || 'baseline priority' };
}

export function registerGoalTools(server: McpServer, brain: DevBrain): void {
  // --- 1. Set project vision ---
  server.tool(
    'devbrain_set_project_vision',
    'Set or update the vision of the active project (description, features, stack, constraints).',
    {
      description: z.string().describe('One-paragraph description of what the project is and why it exists'),
      features: z.array(z.string()).optional().describe('Key features the project provides'),
      stack: z.array(z.object({
        layer: z.string(),
        tech: z.string(),
      }).strict()).optional().describe('Technology stack by layer (frontend, backend, db, etc.)'),
      constraints: z.array(z.string()).optional().describe('Technical or business constraints'),
    },
    async ({ description, features, stack, constraints }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const vision = setProjectVision(brain.store.getDb(), brain.activeProjectId, {
        description,
        features,
        stack,
        constraints,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(vision, null, 2) }],
      };
    },
  );

  // --- 2. Add goal ---
  server.tool(
    'devbrain_add_goal',
    'Create a new goal (objective) for the active project, optionally linking it to existing entities.',
    {
      title: z.string().min(1).describe('Short goal title'),
      description: z.string().optional().describe('Longer description of the goal'),
      priority: priorityEnum.optional().describe('Priority (default: P1)'),
      parent_goal_id: z.string().optional().describe('Parent goal for hierarchical goals'),
      link_entities: z.array(z.string()).optional().describe('Entity IDs to link to the new goal (role: implements)'),
    },
    async ({ title, description, priority, parent_goal_id, link_entities }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const db = brain.store.getDb();
      const goal = createGoal(db, brain.activeProjectId, {
        title,
        description: description ?? null,
        priority,
        parentGoalId: parent_goal_id ?? null,
      });

      if (link_entities && link_entities.length > 0) {
        for (const entityId of link_entities) {
          try {
            linkGoalEntity(db, goal.id, entityId, 'implements');
          } catch (e) {
            console.error(`Failed to link entity ${entityId} to goal ${goal.id}:`, e);
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(goal, null, 2) }],
      };
    },
  );

  // --- 3. Update goal status ---
  server.tool(
    'devbrain_update_goal_status',
    'Update the status of a goal (not_started, in_progress, done, blocked).',
    {
      goal_id: z.string().describe('Goal ID to update'),
      status: statusEnum.describe('New status'),
    },
    async ({ goal_id, status }) => {
      const db = brain.store.getDb();
      const existing = getGoal(db, goal_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Goal not found: ${goal_id}` }], isError: true };
      }

      const updated = updateGoalStatus(db, goal_id, status as GoalStatus);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  // --- 4. Link goal ↔ entity ---
  server.tool(
    'devbrain_link_goal_entity',
    'Link a goal to an entity with a specific role (implements, blocks, depends_on, touches).',
    {
      goal_id: z.string().describe('Goal ID'),
      entity_id: z.string().describe('Entity ID'),
      role: roleEnum.describe('Link role'),
    },
    async ({ goal_id, entity_id, role }) => {
      const db = brain.store.getDb();

      if (!getGoal(db, goal_id)) {
        return { content: [{ type: 'text' as const, text: `Goal not found: ${goal_id}` }], isError: true };
      }
      if (!brain.store.getEntity(entity_id)) {
        return { content: [{ type: 'text' as const, text: `Entity not found: ${entity_id}` }], isError: true };
      }

      linkGoalEntity(db, goal_id, entity_id, role);
      return {
        content: [{ type: 'text' as const, text: `Linked goal ${goal_id} ↔ entity ${entity_id} (role: ${role}).` }],
      };
    },
  );

  // --- 5. Get delta ---
  server.tool(
    'devbrain_get_delta',
    'Compute the completion delta for the active project: how far are we from done? Breakdown by status and priority.',
    {
      project_id: z.string().optional().describe('Project ID (defaults to active project)'),
    },
    async ({ project_id }) => {
      const projectId = requireActiveProject(brain, project_id);
      if (!projectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const delta = getGoalDelta(brain.store.getDb(), projectId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(delta, null, 2) }],
      };
    },
  );

  // --- 6. Generate mission context ---
  server.tool(
    'devbrain_generate_mission_context',
    'Generate a full mission-ready prompt for executing a specific goal (vision + entities + conventions + lessons).',
    {
      goal_id: z.string().describe('Goal ID'),
      max_lessons: z.number().int().min(0).max(20).optional().describe('Max relevant lessons to include (default 5)'),
      max_conventions: z.number().int().min(0).max(50).optional().describe('Max conventions to include (default 10)'),
    },
    async ({ goal_id, max_lessons, max_conventions }) => {
      try {
        const ctx = await generateMissionContext(brain.store, brain.vectorStore, brain.embeddingProvider, {
          goalId: goal_id,
          maxLessons: max_lessons,
          maxConventions: max_conventions,
        });

        // Serialize with prompt first for easy copy-paste
        const out = {
          prompt: ctx.prompt,
          files: ctx.files,
          conventions: ctx.conventions,
          lessons: ctx.lessons,
          team_suggestion: ctx.team_suggestion,
          estimated_complexity: ctx.estimated_complexity,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Mission context generation failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // --- 7. Suggest next actions ---
  server.tool(
    'devbrain_suggest_next_actions',
    'Suggest the next N goals to work on based on priority, status, dependencies, and available knowledge.',
    {
      project_id: z.string().optional().describe('Project ID (defaults to active project)'),
      limit: z.number().int().min(1).max(20).optional().describe('Max suggestions (default 3)'),
    },
    async ({ project_id, limit }) => {
      const projectId = requireActiveProject(brain, project_id);
      if (!projectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }

      const db = brain.store.getDb();
      const candidates = listGoals(db, projectId).filter(
        g => g.status !== 'done',
      );

      // Precompute parent done state
      const parentDoneMap = new Map<string, boolean>();
      for (const g of candidates) {
        if (!g.parentGoalId) continue;
        const parent = getGoal(db, g.parentGoalId);
        parentDoneMap.set(g.parentGoalId, parent?.status === 'done');
      }

      const scored: ScoredGoal[] = [];
      for (const goal of candidates) {
        const parentDone = goal.parentGoalId
          ? parentDoneMap.get(goal.parentGoalId) ?? true
          : true;

        const entities = getGoalEntities(db, goal.id);
        const hasEntities = entities.length > 0;

        let hasLessons = false;
        try {
          const embedding = await brain.embeddingProvider.embed(goal.title);
          if (embedding.length > 0) {
            const lessons = brain.vectorStore.searchLessons(embedding, 1);
            hasLessons = lessons.length > 0;
          }
        } catch (err) {
          console.error(`[goals:lesson-recall] ${err instanceof Error ? err.message : String(err)}`);
        }

        scored.push(scoreGoalForNextAction(goal, parentDone, hasEntities, hasLessons));
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit ?? 3);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(top, null, 2) }],
      };
    },
  );

  // --- Bonus: list goals + mission log (convenience) ---
  server.tool(
    'devbrain_list_goals',
    'List goals for the active project with optional filters.',
    {
      status: statusEnum.optional().describe('Filter by status'),
      priority: priorityEnum.optional().describe('Filter by priority'),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ status, priority, limit, offset }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }
      const goals = listGoals(brain.store.getDb(), brain.activeProjectId, {
        status: status as GoalStatus | undefined,
        priority: priority as GoalPriority | undefined,
        limit, offset,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(goals, null, 2) }] };
    },
  );

  server.tool(
    'devbrain_get_project_vision',
    'Get the vision document of the active project.',
    {},
    async () => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project. Use devbrain_set_project first.' }], isError: true };
      }
      const vision = getProjectVision(brain.store.getDb(), brain.activeProjectId);
      return {
        content: [{
          type: 'text' as const,
          text: vision ? JSON.stringify(vision, null, 2) : 'No vision set. Use devbrain_set_project_vision to create one.',
        }],
      };
    },
  );

  server.tool(
    'devbrain_record_goal_mission',
    'Record that a mission (external execution unit) contributed to a goal, with outcome.',
    {
      goal_id: z.string().describe('Goal ID'),
      mission_id: z.string().describe('Mission identifier (external)'),
      outcome: z.enum(GOAL_MISSION_OUTCOMES).optional(),
    },
    async ({ goal_id, mission_id, outcome }) => {
      const db = brain.store.getDb();
      if (!getGoal(db, goal_id)) {
        return { content: [{ type: 'text' as const, text: `Goal not found: ${goal_id}` }], isError: true };
      }
      recordGoalMission(db, goal_id, mission_id, outcome ?? null);
      const missions = getGoalMissions(db, goal_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(missions, null, 2) }] };
    },
  );

  server.tool(
    'devbrain_unlink_goal_entity',
    'Remove a goal ↔ entity link.',
    {
      goal_id: z.string(),
      entity_id: z.string(),
    },
    async ({ goal_id, entity_id }) => {
      unlinkGoalEntity(brain.store.getDb(), goal_id, entity_id);
      return { content: [{ type: 'text' as const, text: `Unlinked goal ${goal_id} ↔ entity ${entity_id}.` }] };
    },
  );

  // --- Delete a goal (cascades to goal_entities + goal_missions links) ---
  server.tool(
    'devbrain_delete_goal',
    'Delete a project goal. Cascades to goal_entities and goal_missions links. Does not delete linked entities themselves.',
    {
      goal_id: z.string().describe('Goal ID to delete'),
    },
    async ({ goal_id }) => {
      const db = brain.store.getDb();
      const existing = getGoal(db, goal_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Goal not found: ${goal_id}` }], isError: true };
      }
      deleteGoal(db, goal_id);
      return {
        content: [{ type: 'text' as const, text: `Goal "${existing.title}" deleted` }],
      };
    },
  );

  // --- Get entities linked to a goal (with their role) ---
  server.tool(
    'devbrain_get_goal_entities',
    'Return all entities linked to a given goal with their role (implements/blocks/depends_on/touches).',
    {
      goal_id: z.string().describe('Goal ID'),
    },
    async ({ goal_id }) => {
      const db = brain.store.getDb();
      const existing = getGoal(db, goal_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Goal not found: ${goal_id}` }], isError: true };
      }
      const entities = getGoalEntities(db, goal_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entities, null, 2) }],
      };
    },
  );
}
