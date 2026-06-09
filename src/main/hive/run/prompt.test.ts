import { describe, it, expect } from 'vitest';

import { BUILTIN_ROLE_PROMPTS, resolveRolePrompt, buildTaskPrompt } from './prompt';
import type { HiveStory } from '../../../types/hive';

function story(over: Partial<HiveStory> = {}): HiveStory {
  return {
    id: 'AUTH-3',
    title: 'Add login form',
    status: 'pending',
    role: 'senior',
    points: 3,
    team: 'web',
    dependsOn: [],
    acceptanceCriteria: ['Form validates email', 'Submits to /login'],
    createdAt: '',
    updatedAt: '',
    body: 'Implement the login form component.',
    ...over,
  };
}

describe('resolveRolePrompt', () => {
  it('uses the workspace override when present', () => {
    expect(resolveRolePrompt('senior', 'OVERRIDE TEXT')).toBe('OVERRIDE TEXT');
  });
  it('falls back to the built-in for the role when no override', () => {
    expect(resolveRolePrompt('qa', null)).toBe(BUILTIN_ROLE_PROMPTS.qa);
  });
  it('has a built-in for every role', () => {
    for (const r of ['manager', 'tech-lead', 'senior', 'intermediate', 'junior', 'qa'] as const) {
      expect(BUILTIN_ROLE_PROMPTS[r].length).toBeGreaterThan(0);
    }
  });
  it('built-ins mention the worktree boundary', () => {
    expect(BUILTIN_ROLE_PROMPTS.senior.toLowerCase()).toContain('worktree');
  });
});

describe('buildTaskPrompt', () => {
  const p = buildTaskPrompt(story(), {
    repoName: 'acme-web',
    featureBranch: 'feat/AUTH-3',
    workspacePath: '/ws',
  });
  it('includes the story id, title and body', () => {
    expect(p).toContain('AUTH-3');
    expect(p).toContain('Add login form');
    expect(p).toContain('Implement the login form component.');
  });
  it('renders acceptance criteria as a checklist', () => {
    expect(p).toContain('- [ ] Form validates email');
    expect(p).toContain('- [ ] Submits to /login');
  });
  it('states the branch/repo and the commit + test instruction', () => {
    expect(p).toContain('feat/AUTH-3');
    expect(p).toContain('acme-web');
    expect(p.toLowerCase()).toContain('commit');
    expect(p.toLowerCase()).toContain('test');
  });
  it('renders fallbacks for empty criteria and empty body', () => {
    const p2 = buildTaskPrompt(story({ acceptanceCriteria: [], body: '' }), {
      repoName: 'acme-web',
      featureBranch: 'feat/AUTH-3',
      workspacePath: '/ws',
    });
    expect(p2).toContain('(no acceptance criteria specified)');
    expect(p2).toContain('(no description)');
  });
  it('tells the worker where to write a blocking question', () => {
    expect(p).toContain('/ws/.hive/state/questions/AUTH-3.md');
    expect(p.toLowerCase()).toContain('question');
  });
});
