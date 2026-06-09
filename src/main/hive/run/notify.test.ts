import { describe, it, expect, vi } from 'vitest';

import { notifyNeedsInput, type Notifier } from './notify';

describe('notifyNeedsInput', () => {
  it('shows a notification with the story + question', () => {
    const shown: Array<{ title: string; body: string }> = [];
    const notifier: Notifier = {
      supported: () => true,
      show: (title, body) => shown.push({ title, body }),
    };
    notifyNeedsInput(notifier, { storyId: 'AUTH-3', question: 'Which DB?' });
    expect(shown).toHaveLength(1);
    expect(shown[0].title.toLowerCase()).toContain('input');
    expect(shown[0].body).toContain('AUTH-3');
    expect(shown[0].body).toContain('Which DB?');
  });

  it('no-ops when notifications are unsupported', () => {
    const notifier: Notifier = { supported: () => false, show: vi.fn() };
    notifyNeedsInput(notifier, { storyId: 'X', question: 'Q' });
    expect(notifier.show).not.toHaveBeenCalled();
  });
});
