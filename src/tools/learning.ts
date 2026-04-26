import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevBrain } from '../server.js';
import { computeForgetConfidence } from '../learning/feedback-loop.js';

export function registerLearningTools(server: McpServer, brain: DevBrain): void {
  server.tool(
    'devbrain_learning_report',
    'Get the learning report from the last session processing. Shows patterns detected, lessons generated, rule proposals, and any errors.',
    {},
    async () => {
      if (!brain.lastLearningReport) {
        return { content: [{ type: 'text' as const, text: 'No learning report available. End a session first.' }] };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(brain.lastLearningReport, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_review_proposals',
    'List pending rule evolution proposals for the active project. Each proposal suggests a severity change (e.g., should → must).',
    {
      status: z.enum(['pending', 'accepted', 'rejected']).optional().describe('Filter by status (default: pending)'),
    },
    async ({ status }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project.' }], isError: true };
      }
      if (!brain.learningOrchestrator) {
        return { content: [{ type: 'text' as const, text: 'Learning engine not initialized.' }], isError: true };
      }

      const proposals = brain.learningOrchestrator.learningStore.listProposals(
        brain.activeProjectId, status ?? 'pending',
      );

      if (proposals.length === 0) {
        return { content: [{ type: 'text' as const, text: `No ${status ?? 'pending'} proposals.` }] };
      }

      // Enrich with rule content
      const enriched = proposals.map(p => {
        const rule = brain.store.getRule(p.ruleId);
        return {
          ...p,
          ruleContent: rule?.content ?? '(rule deleted)',
          ruleScope: rule?.scope ?? 'unknown',
        };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(enriched, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_accept_proposal',
    'Accept a rule evolution proposal. Applies the severity change to the rule.',
    {
      proposal_id: z.string().describe('ID of the proposal to accept'),
    },
    async ({ proposal_id }) => {
      if (!brain.learningOrchestrator) {
        return { content: [{ type: 'text' as const, text: 'Learning engine not initialized.' }], isError: true };
      }

      const ls = brain.learningOrchestrator.learningStore;
      const proposal = ls.getProposal(proposal_id);
      if (!proposal) {
        return { content: [{ type: 'text' as const, text: `Proposal not found: ${proposal_id}` }], isError: true };
      }
      if (proposal.status !== 'pending') {
        return { content: [{ type: 'text' as const, text: `Proposal already ${proposal.status}.` }], isError: true };
      }

      // Apply the severity change
      const severity = proposal.proposedSeverity as 'must' | 'should' | 'prefer';
      brain.store.updateRule(proposal.ruleId, { severity });
      const resolved = ls.resolveProposal(proposal_id, 'accepted');

      return {
        content: [{ type: 'text' as const, text: `Proposal accepted. Rule severity changed to "${severity}".\n${JSON.stringify(resolved, null, 2)}` }],
      };
    },
  );

  server.tool(
    'devbrain_reject_proposal',
    'Reject a rule evolution proposal. The rule remains unchanged.',
    {
      proposal_id: z.string().describe('ID of the proposal to reject'),
    },
    async ({ proposal_id }) => {
      if (!brain.learningOrchestrator) {
        return { content: [{ type: 'text' as const, text: 'Learning engine not initialized.' }], isError: true };
      }

      const ls = brain.learningOrchestrator.learningStore;
      const proposal = ls.getProposal(proposal_id);
      if (!proposal) {
        return { content: [{ type: 'text' as const, text: `Proposal not found: ${proposal_id}` }], isError: true };
      }
      if (proposal.status !== 'pending') {
        return { content: [{ type: 'text' as const, text: `Proposal already ${proposal.status}.` }], isError: true };
      }

      const resolved = ls.resolveProposal(proposal_id, 'rejected');
      return {
        content: [{ type: 'text' as const, text: `Proposal rejected.\n${JSON.stringify(resolved, null, 2)}` }],
      };
    },
  );

  server.tool(
    'devbrain_forget',
    'Forget a lesson or pattern. Reduces confidence to below injection threshold rather than deleting (prevents re-learning).',
    {
      lesson_id: z.string().describe('ID of the lesson to forget'),
    },
    async ({ lesson_id }) => {
      const lesson = brain.store.getLesson(lesson_id);
      if (!lesson) {
        return { content: [{ type: 'text' as const, text: `Lesson not found: ${lesson_id}` }], isError: true };
      }

      const newConfidence = computeForgetConfidence();
      brain.store.updateLesson(lesson_id, {
        confidence: newConfidence,
        metadata: {
          ...(lesson.metadata ?? {}),
          forgotten_at: new Date().toISOString(),
        },
      });

      return {
        content: [{ type: 'text' as const, text: `Lesson confidence reduced to ${newConfidence} (below injection threshold). It won't appear in context anymore.` }],
      };
    },
  );

  server.tool(
    'devbrain_developer_profile',
    'View the developer profile for the active project. Shows coding patterns, session statistics, and inferred tendencies.',
    {},
    async () => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project.' }], isError: true };
      }
      if (!brain.learningOrchestrator) {
        return { content: [{ type: 'text' as const, text: 'Learning engine not initialized.' }], isError: true };
      }

      const profile = brain.learningOrchestrator.learningStore.getProfile(brain.activeProjectId);
      if (!profile) {
        return { content: [{ type: 'text' as const, text: 'No profile yet. Minimum 5 sessions required.' }] };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }],
      };
    },
  );

  server.tool(
    'devbrain_learning_patterns',
    'List detected patterns for the active project. Shows recurring action sequences, file co-occurrences, and error associations.',
    {
      type: z.enum(['action_sequence', 'file_cooccurrence', 'error_file_association']).optional()
        .describe('Filter by pattern type'),
      limit: z.number().min(1).max(100).optional().describe('Max patterns to return (default 20)'),
    },
    async ({ type, limit }) => {
      if (!brain.activeProjectId) {
        return { content: [{ type: 'text' as const, text: 'No active project.' }], isError: true };
      }
      if (!brain.learningOrchestrator) {
        return { content: [{ type: 'text' as const, text: 'Learning engine not initialized.' }], isError: true };
      }

      const patterns = brain.learningOrchestrator.learningStore.listPatterns(
        brain.activeProjectId, type, limit ?? 20,
      );

      if (patterns.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No patterns detected yet.' }] };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(patterns, null, 2) }],
      };
    },
  );
}
