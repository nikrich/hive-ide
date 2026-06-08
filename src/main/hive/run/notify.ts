/**
 * Desktop notification for worker questions (slice 2b-1). The Electron
 * `Notification` is wrapped behind a `Notifier` so the logic is testable
 * without Electron; `electronNotifier()` is the production binding.
 */

import { Notification } from 'electron';

import type { HiveQuestion } from '../../../types/hive';

export interface Notifier {
  supported: () => boolean;
  show: (title: string, body: string) => void;
}

/** Production notifier backed by Electron's Notification API. */
export function electronNotifier(onClick?: () => void): Notifier {
  return {
    supported: () => Notification.isSupported(),
    show: (title, body) => {
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
    },
  };
}

/** Fire a "needs input" notification (no-op when unsupported). */
export function notifyNeedsInput(notifier: Notifier, q: HiveQuestion): void {
  if (!notifier.supported()) return;
  notifier.show('Hive needs input', `${q.storyId}: ${q.question}`);
}
