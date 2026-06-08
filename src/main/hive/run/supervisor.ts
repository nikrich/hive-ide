/**
 * Autonomous run loop (slice 2b-1). A Start/Stop interval tick that runs
 * `pending` stories serially via the existing run orchestration — one at a
 * time, never auto-retrying a non-pending story. `schedule` is injected so the
 * tick is testable without real timers; production passes an unref'd setTimeout.
 */

import type { HiveLoopStatus } from '../../../types/hive';

export interface SupervisorDeps {
  /** Pending story ids in run order, for the active workspace. */
  getPendingStoryIds: () => Promise<string[]>;
  isRunnerBusy: () => boolean;
  /** Existing run orchestration; fire-and-forget per tick. */
  runStory: (storyId: string) => Promise<void>;
  onStatus: (s: HiveLoopStatus) => void;
  /** Schedule the next tick after `ms`. */
  schedule: (ms: number, fn: () => void) => void;
}

export interface Supervisor {
  start(): void;
  stop(): void;
  status(): HiveLoopStatus;
}

/** Tick cadence while working vs idle (idle backs off). */
export const ACTIVE_TICK_MS = 1500;
export const IDLE_TICK_MS = 8000;

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let running = false;
  let currentStory: string | null = null;

  const push = (): void => deps.onStatus({ running, currentStory });

  const tick = (): void => {
    if (!running) return;
    if (deps.isRunnerBusy()) {
      // A run is in flight — leave currentStory as-is and re-check soon.
      deps.schedule(ACTIVE_TICK_MS, tick);
      return;
    }
    void (async () => {
      let pending: string[] = [];
      try {
        pending = await deps.getPendingStoryIds();
      } catch {
        pending = [];
      }
      if (!running) return;
      const next = pending[0];
      if (next !== undefined) {
        currentStory = next;
        push();
        void deps.runStory(next).catch(() => undefined);
        deps.schedule(ACTIVE_TICK_MS, tick);
      } else {
        currentStory = null;
        push();
        deps.schedule(IDLE_TICK_MS, tick);
      }
    })();
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      push();
      deps.schedule(0, tick);
    },
    stop(): void {
      running = false;
      currentStory = null;
      push();
    },
    status(): HiveLoopStatus {
      return { running, currentStory };
    },
  };
}
