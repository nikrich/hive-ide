import { describe, it, expect } from 'vitest';

import { buildIndexSystemPrompt, buildIndexPrompt } from './indexer';

describe('buildIndexSystemPrompt', () => {
  const sys = buildIndexSystemPrompt();

  it('forbids writing / editing / committing', () => {
    expect(sys).toMatch(/do not (edit|write|commit|modify)/i);
    expect(sys.toLowerCase()).toContain('read-only');
  });

  it('tells the agent its output is its final message', () => {
    expect(sys.toLowerCase()).toContain('final message');
  });

  it('mentions the things to read (readme, manifests, structure, test command)', () => {
    const lower = sys.toLowerCase();
    expect(lower).toContain('readme');
    expect(lower).toContain('package.json');
    expect(lower).toContain('test');
  });
});

describe('buildIndexPrompt', () => {
  it('names the repo', () => {
    expect(buildIndexPrompt('bff-web')).toContain('bff-web');
  });

  it('asks for the required profile sections', () => {
    const p = buildIndexPrompt('bff-web').toLowerCase();
    expect(p).toContain('purpose');
    expect(p).toContain('stack');
    expect(p).toContain('key areas');
    expect(p).toContain('entry point');
    expect(p).toContain('test command');
  });
});
