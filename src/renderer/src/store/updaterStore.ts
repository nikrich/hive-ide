/**
 * Renderer updater store (feat/auto-updater).
 *
 * Subscribes to `window.hive.updater.onStatus` and mirrors the latest status.
 * On `downloaded` it posts an action toast through the notifications store
 * ("Restart to update"). Manual checks (`checkForUpdates`) flag the next
 * terminal status so the operator gets feedback ("up to date" / errors /
 * "updates run in packaged builds only") without background checks nagging.
 */

import { create } from 'zustand';

import type { UpdaterStatus } from '../../../preload/api';
import { notify } from './notificationsStore';

/** Set true by a manual check; consumed by the next terminal status. */
let manualPending = false;

export interface UpdaterState {
  status: UpdaterStatus;
  /** Current app version (loaded by `init`); '' until resolved. */
  version: string;
  /** Subscribe to pushes + load version. Returns an unsubscribe; call it on unmount. */
  init: () => () => void;
  /** Manual check — gives the operator explicit feedback. */
  checkForUpdates: () => void;
  /** Quit and install a downloaded update. */
  quitAndInstall: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: { phase: 'idle' },
  version: '',

  init: () => {
    const bridge = window.hive?.updater;
    if (!bridge) return () => undefined;

    void bridge
      .getVersion()
      .then((v) => set({ version: v }))
      .catch(() => undefined);

    return bridge.onStatus((status) => {
      set({ status });

      if (status.phase === 'downloaded') {
        const v = status.version ? ` ${status.version}` : '';
        notify('info', `Hive IDE${v} is ready to install`, [
          { label: 'Restart to update', run: () => void bridge.quitAndInstall() },
        ]);
        manualPending = false;
        return;
      }

      if (!manualPending) return;
      // Manual-check feedback for terminal phases.
      if (status.phase === 'not-available') {
        manualPending = false;
        notify('info', `Hive IDE ${get().version} is up to date`);
      } else if (status.phase === 'unsupported') {
        manualPending = false;
        notify('info', 'Updates run in packaged builds only');
      } else if (status.phase === 'error') {
        manualPending = false;
        notify('error', `Update check failed: ${status.error ?? 'unknown error'}`);
      }
    });
  },

  checkForUpdates: () => {
    manualPending = true;
    void window.hive?.updater?.check();
  },

  quitAndInstall: () => {
    void window.hive?.updater?.quitAndInstall();
  },
}));
