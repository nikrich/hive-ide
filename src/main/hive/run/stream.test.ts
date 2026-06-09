import { describe, it, expect } from 'vitest';

import { parseClaudeStreamLine, parseClaudeResult } from './stream';

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

describe('parseClaudeResult', () => {
  it('returns the raw result string from a result line', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'the profile body' });
    expect(parseClaudeResult(line)).toBe('the profile body');
  });

  it('returns the result text even on an error result (caller decides)', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'boom' });
    expect(parseClaudeResult(line)).toBe('boom');
  });

  it('returns null for a non-result line', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(parseClaudeResult(line)).toBeNull();
  });

  it('returns null for a blank line', () => {
    expect(parseClaudeResult('')).toBeNull();
    expect(parseClaudeResult('   ')).toBeNull();
  });

  it('returns null for non-JSON (tolerated)', () => {
    expect(parseClaudeResult('not json')).toBeNull();
  });

  it('returns null when result is missing or not a string', () => {
    expect(parseClaudeResult(JSON.stringify({ type: 'result' }))).toBeNull();
    expect(parseClaudeResult(JSON.stringify({ type: 'result', result: 42 }))).toBeNull();
  });

  it('returns null for an empty result string', () => {
    expect(parseClaudeResult(JSON.stringify({ type: 'result', result: '' }))).toBeNull();
    expect(parseClaudeResult(JSON.stringify({ type: 'result', result: '   ' }))).toBeNull();
  });

  it('does not throw on a top-level JSON null line', () => {
    expect(parseClaudeResult('null')).toBeNull();
  });
});
