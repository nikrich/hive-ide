/**
 * Operator chat persistence — `.hive/chat.ndjson` (one JSON message per line).
 *
 * The operator's messages are APPENDED here by the IDE; the manager process
 * appends its replies to the same file. The hive reader tails the file and
 * pushes new messages to the renderer — files stay the single source of truth
 * (no in-memory chat state in main).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { HiveChatMessage } from '../../types/hive';

/** Append one operator message. Creates the file on first write. */
export async function appendChatMessage(
  workspacePath: string,
  text: string,
  now: Date = new Date(),
): Promise<void> {
  const txt = text.trim();
  if (txt === '') throw new Error('hive: chat message is empty');
  const msg: HiveChatMessage = { ts: now.toISOString(), who: 'you', txt };
  await fs.appendFile(
    join(workspacePath, '.hive', 'chat.ndjson'),
    `${JSON.stringify(msg)}\n`,
    'utf8',
  );
}
