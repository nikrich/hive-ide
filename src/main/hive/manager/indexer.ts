/**
 * Indexer prompts (pure) — slice 2b-2a.
 *
 * The indexer is a READ-ONLY analyst run in the repo's cwd (NO worktree). Its
 * FINAL message text IS the profile body — hive captures it via the runner's
 * onResult and writes `.hive/index/<repo>.md`. The agent never writes files.
 */

/** System prompt: a read-only repo analyst that emits its profile as final text. */
export function buildIndexSystemPrompt(): string {
  return [
    'You are a READ-ONLY repository analyst. Your sole job is to read a code',
    'repository and produce a compact profile of it.',
    '',
    'Hard rules:',
    '- Do NOT edit, write, create, delete, or modify any file.',
    '- Do NOT commit, stage, push, or run git write commands.',
    '- Do NOT run build/test/install commands — only READ.',
    '- Read the README, the manifests (package.json, go.mod, pom.xml,',
    '  Cargo.toml, pyproject.toml, etc.), the top-level directory structure,',
    '  the key entry points, and how tests are run.',
    '',
    'Output the profile as your FINAL message only — no preamble, no trailing',
    'commentary. Keep it concise (a dozen lines is plenty).',
  ].join('\n');
}

/** Task prompt: profile this one repo into the required sections. */
export function buildIndexPrompt(repoName: string): string {
  return [
    `Profile the repository "${repoName}" that you are currently inside.`,
    '',
    'Produce a concise profile with these sections (one short paragraph or a',
    'few bullet points each):',
    '- Purpose: what this repo is and does.',
    '- Stack: languages, frameworks, notable tooling.',
    '- Key areas / directories: where the important code lives.',
    '- Public surface / entry points: the main modules, commands, or endpoints.',
    '- Test command: the exact command to run its tests.',
    '',
    'Be concise. Your final message is the profile and nothing else.',
  ].join('\n');
}
