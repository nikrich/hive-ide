import { describe, it, expect } from 'vitest';

import { parseClaudeStreamLine } from './stream';

describe('parseClaudeStreamLine', () => {
  it('returns null for a blank line', () => {
    expect(parseClaudeStreamLine('')).toBeNull();
    expect(parseClaudeStreamLine('   ')).toBeNull();
  });

  it('returns null for a non-JSON line (tolerated)', () => {
    expect(parseClaudeStreamLine('not json')).toBeNull();
  });

  it('renders assistant text content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Editing the form' }] },
    });
    expect(parseClaudeStreamLine(line)).toBe('Editing the form');
  });

  it('renders a tool_use as an arrow line with the tool name', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });
    expect(parseClaudeStreamLine(line)).toBe('→ Bash: npm test');
  });

  it('renders a successful result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    expect(parseClaudeStreamLine(line)).toContain('✓');
  });

  it('renders an error result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(parseClaudeStreamLine(line)).toContain('✗');
  });

  it('returns null for an init/system line', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });

  it('does not throw on a top-level JSON null line', () => {
    expect(parseClaudeStreamLine('null')).toBeNull();
  });

  it('does not throw on a null content element', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [null, { type: 'text', text: 'ok' }] } });
    expect(parseClaudeStreamLine(line)).toBe('ok');
  });

  it('does not throw on non-array content', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: 'hi' } });
    expect(parseClaudeStreamLine(line)).toBeNull();
  });
});
