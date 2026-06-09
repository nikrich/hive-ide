/**
 * Manager lane (slice 2b-2a) — a SECOND runner instance + a FIFO job queue.
 *
 * Jobs run ONE AT A TIME within the lane; the worker lane is independent and
 * may overlap. A job is generic (it builds its own RunSpec and handles its own
 * result/failure) so slice 2b-2b can add a `decompose` job kind without
 * touching the lane. `createRunner`/`now`/`newRunId` are injected so the lane
 * is testable without a real `claude` or real timers.
 */

import type { HiveManagerStatusEvent } from '../../../types/hive';
import { createRunner as defaultCreateRunner, type Runner, type RunSpec } from '../run/runner';

/** One unit of manager-lane work. Generic over kind via its callbacks. */
export interface ManagerJob {
  activity: HiveManagerStatusEvent['activity'];
  /** repo name | requirement id — also the status-event target. */
  target: string;
  /** Build the claude RunSpec for this job (cwd, prompts, etc). */
  buildSpec: (runId: string) => RunSpec;
  /** The run's captured final text (non-empty) on a clean, successful exit. */
  onResult: (text: string) => void | Promise<void>;
  /** Non-zero exit, spawn error, or empty result. */
  onFailure: (detail: string) => void | Promise<void>;
}

export interface ManagerLaneDeps {
  /** Factory for the lane's dedicated runner. Defaults to the real one. */
  createRunner?: () => Runner;
  onStatus: (e: HiveManagerStatusEvent) => void;
  now: () => string;
  newRunId: () => string;
}

/** A compact view of what the lane is doing (for index-status derivation). */
export interface ManagerJobRef {
  activity: HiveManagerStatusEvent['activity'];
  target: string;
}

export interface ManagerLane {
  enqueue(job: ManagerJob): void;
  /** The job currently running, or null. */
  current(): ManagerJobRef | null;
  /** Jobs waiting behind the current one, in FIFO order. */
  queued(): ManagerJobRef[];
  isBusy(): boolean;
  /** Stop the active run and clear the queue (before-quit). */
  dispose(): Promise<void>;
}

export function createManagerLane(deps: ManagerLaneDeps): ManagerLane {
  const runner = (deps.createRunner ?? defaultCreateRunner)();
  const queue: ManagerJob[] = [];
  let active: ManagerJob | null = null;
  let activeRunId: string | null = null;

  const ref = (j: ManagerJob): ManagerJobRef => ({ activity: j.activity, target: j.target });
  const status = (j: ManagerJob, s: HiveManagerStatusEvent['status'], extra: Partial<HiveManagerStatusEvent> = {}): void =>
    deps.onStatus({ activity: j.activity, target: j.target, status: s, ...extra });

  const pump = (): void => {
    if (active !== null) return;
    const job = queue.shift();
    if (!job) return;
    active = job;

    const runId = deps.newRunId();
    activeRunId = runId;
    let result: string | null = null;

    runner.start(job.buildSpec(runId), {
      onLog: () => {},
      onStatus: (s) => {
        // The runner emits starting/running/exited; forward only starting+running
        // here. We emit 'exited' ourselves once the outcome is known.
        if (s !== 'exited') status(job, s);
      },
      onResult: (text) => { result = text; },
      onExit: (r) => {
        const failed = r.code !== 0 || r.signal !== null || result === null || result.trim() === '';
        const settle = (): void => {
          active = null;
          activeRunId = null;
          pump();
        };

        // Emit the 'exited' status before invoking the job callback so a callback
        // that throws still produces the exited event. Then invoke the callback
        // inside try/catch so a SYNCHRONOUS throw never wedges the lane: settle()
        // must always run (a rejected Promise is handled by .finally below).
        let ret: void | Promise<void>;
        if (failed) {
          const detail =
            r.signal !== null ? `interrupted (${r.signal})`
            : r.code !== 0 && r.code !== null ? `exit ${r.code}`
            : r.code === null ? 'spawn error'
            : 'empty result';
          status(job, 'exited', { outcome: 'failure', detail });
          try {
            ret = job.onFailure(detail);
          } catch {
            settle();
            return;
          }
        } else {
          status(job, 'exited', { outcome: 'success' });
          try {
            ret = job.onResult(result as string);
          } catch {
            settle();
            return;
          }
        }

        if (ret && typeof (ret as Promise<void>).then === 'function') {
          void (ret as Promise<void>).then(undefined, () => {}).finally(settle);
        } else {
          settle();
        }
      },
    });
  };

  return {
    enqueue(job) {
      queue.push(job);
      pump();
    },
    current: () => (active ? ref(active) : null),
    queued: () => queue.map(ref),
    isBusy: () => active !== null,
    dispose: async () => {
      queue.length = 0;
      // Stop the active run with the SAME id it was started with — runner.stop
      // early-returns on a mismatched id, so a fresh id would be a no-op.
      if (activeRunId !== null) {
        await runner.stop(activeRunId).catch(() => undefined);
      }
    },
  };
}
