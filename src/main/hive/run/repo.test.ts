import { describe, it, expect } from 'vitest';

import { resolveRepoForStory } from './repo';

const repos = [
  { name: 'web', path: '/r/web', isGitRepo: true },
  { name: 'api', path: '/r/api', isGitRepo: true },
];

describe('resolveRepoForStory', () => {
  it('matches the repo whose name equals the story team', () => {
    expect(resolveRepoForStory('api', repos)).toBe('/r/api');
  });
  it('falls back to the first repo when team is unknown', () => {
    expect(resolveRepoForStory('nope', repos)).toBe('/r/web');
  });
  it('falls back to the first repo when team is empty', () => {
    expect(resolveRepoForStory('', repos)).toBe('/r/web');
  });
  it('returns null when there are no repos', () => {
    expect(resolveRepoForStory('web', [])).toBeNull();
  });
});
