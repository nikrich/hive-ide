/**
 * Parse one `claude -p --output-format stream-json` NDJSON line into a single
 * human-readable log line, or null to skip (blank/system/unknown/malformed).
 * Pure + defensive — a bad line must never throw.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function briefInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  const first = Object.values(input).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

export function parseClaudeStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let ev: unknown;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== 'object') return null;
  const obj = ev as Record<string, unknown>;

  const type = obj.type;
  if (type === 'assistant') {
    const message = obj.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    const parts: string[] = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const block = b as ContentBlock;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text.trim());
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const arg = briefInput(block.input);
        parts.push(`→ ${block.name}${arg ? `: ${arg}` : ''}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (type === 'result') {
    const isError = obj.is_error === true;
    const result = typeof obj.result === 'string' ? obj.result : '';
    return isError ? `✗ run failed${result ? `: ${result}` : ''}` : `✓ ${result || 'done'}`;
  }

  // system / user(tool_result) / unknown → skip.
  return null;
}
