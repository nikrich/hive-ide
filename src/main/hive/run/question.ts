/**
 * Worker question read/answer (slice 2b-1). A blocked worker writes a question
 * to `.hive/state/questions/<storyId>.md` and stops. The operator answers; the
 * answer is appended to the story body (so the next run's task prompt carries
 * it), the question file is removed, and the story flips back to `pending` for
 * the loop to re-run.
 */

import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseStory } from '../parse';
import { serializeStory, eventLine } from './serialize';

function questionPath(ws: string, storyId: string): string {
  return join(ws, '.hive', 'state', 'questions', `${storyId}.md`);
}
function storyPath(ws: string, storyId: string): string {
  return join(ws, '.hive', 'state', 'stories', `${storyId}.md`);
}

/** The pending question for a story, or null when none. */
export async function readQuestion(ws: string, storyId: string): Promise<string | null> {
  try {
    const text = await readFile(questionPath(ws, storyId), 'utf8');
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Apply an answer: append a Q&A block to the story body, delete the question
 * file, set the story back to `pending`, append an `answered` event.
 */
export async function answerQuestion(
  ws: string,
  storyId: string,
  answer: string,
  now: string,
): Promise<void> {
  const question = (await readQuestion(ws, storyId)) ?? '';
  const current = parseStory(await readFile(storyPath(ws, storyId), 'utf8'), storyId);
  const qa = [
    current.body.trim(),
    '',
    '## Prior question',
    question || '(question file missing)',
    '',
    '## Answer',
    answer.trim(),
  ].join('\n');
  await writeFile(
    storyPath(ws, storyId),
    serializeStory({ ...current, status: 'pending', body: qa, updatedAt: now }),
    'utf8',
  );
  await rm(questionPath(ws, storyId), { force: true });
  await appendFile(
    join(ws, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'answered', detail: storyId, level: 'info' }) + '\n',
    'utf8',
  );
}
