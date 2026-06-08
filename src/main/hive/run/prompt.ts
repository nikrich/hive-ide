/**
 * Worker prompt assembly (pure) — slice 2a.
 *
 * The role *system* prompt is a minimal built-in per role, overridable by a
 * workspace `.hive/skills/<role>.md`. The *task* prompt is rendered from the
 * story. Both are pure: callers read any override file off disk and pass its
 * contents in.
 */

import type { HiveRole, HiveStory } from '../../../types/hive';

const COMMON = [
  'You are an autonomous engineering agent working inside an isolated git',
  'worktree. You may edit files, run the project test command, and commit.',
  'When the acceptance criteria are met and tests pass, COMMIT your work with a',
  'clear message. Do not push, open PRs, or touch files outside this worktree.',
].join(' ');

/** Minimal built-in system prompt per role. Overridden by a workspace skill. */
export const BUILTIN_ROLE_PROMPTS: Record<HiveRole, string> = {
  manager: `${COMMON} Act as an engineering manager: keep scope tight and unblock the task.`,
  'tech-lead': `${COMMON} Act as a tech lead: prefer the smallest correct change that fits existing patterns.`,
  senior: `${COMMON} Act as a senior engineer: write clean, well-tested, idiomatic code.`,
  intermediate: `${COMMON} Act as an intermediate engineer: follow existing patterns closely and add tests.`,
  junior: `${COMMON} Act as a junior engineer: make the focused change requested and add a test.`,
  qa: `${COMMON} Act as QA: verify behaviour with tests and harden edge cases.`,
};

/** Override file contents win; otherwise the built-in for the role. */
export function resolveRolePrompt(role: HiveRole, workspaceSkill: string | null): string {
  return workspaceSkill ?? BUILTIN_ROLE_PROMPTS[role];
}

/** Render the worker's task from a story. */
export function buildTaskPrompt(
  story: HiveStory,
  ctx: { repoName: string; featureBranch: string },
): string {
  const criteria =
    story.acceptanceCriteria.length > 0
      ? story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
      : '- [ ] (no acceptance criteria specified)';
  return [
    `# Story ${story.id}: ${story.title}`,
    '',
    `Repo (team): ${ctx.repoName}`,
    `Feature branch (already checked out in this worktree): ${ctx.featureBranch}`,
    '',
    '## Description',
    story.body.trim() || '(no description)',
    '',
    '## Acceptance criteria',
    criteria,
    '',
    '## Definition of done',
    '1. Implement the change in this worktree.',
    '2. Run the project test command and make it pass.',
    '3. Commit your work on the current branch with a clear message.',
  ].join('\n');
}
