import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { createManagerLane, type ManagerJob, type ManagerLaneDeps } from './lane';
import type { RunSpec, RunnerEvents, Runner, SpawnFn } from '../run/runner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 7;
  return child;
}

/**
 * A controllable fake runner: records start() calls and lets the test drive a
 * run to completion (with an optional result + exit code).
 */
function fakeRunner() {
  let busy = false;
  let pending: { spec: RunSpec; events: RunnerEvents } | null = null;
  const runner: Runner = {
    isBusy: () => busy,
    start: (spec, events) => {
      if (busy) throw new Error('busy');
      busy = true;
      pending = { spec, events };
      events.onStatus('starting');
      events.onStatus('running');
    },
    stop: async () => { busy = false; },
  };
  const finish = (opts: { result?: string; code?: number | null; signal?: NodeJS.Signals | null }): void => {
    const p = pending!;
    pending = null;
    busy = false;
    if (opts.result !== undefined && p.events.onResult) p.events.onResult(opts.result);
    p.events.onStatus('exited');
    p.events.onExit({ code: opts.code ?? 0, signal: opts.signal ?? null });
  };
  return { runner, finish, started: () => pending, calls: () => pending };
}

function indexJob(repo: string, sink: (kind: string, repo: string, text?: string) => void): ManagerJob {
  return {
    activity: 'indexing',
    target: repo,
    buildSpec: (runId) => ({
      runId, storyId: repo, role: 'manager', cwd: `/repos/${repo}`,
      taskPrompt: `index ${repo}`, systemPrompt: 'read-only',
    }),
    onResult: (text) => sink('result', repo, text),
    onFailure: (detail) => sink('failure', repo, detail),
  };
}

function harness(over: Partial<ManagerLaneDeps> = {}) {
  const fr = fakeRunner();
  const events: Array<{ activity: string; target: string; status: string; outcome?: string }> = [];
  const deps: ManagerLaneDeps = {
    createRunner: () => fr.runner,
    onStatus: (e) => events.push({ activity: e.activity, target: e.target, status: e.status, outcome: e.outcome }),
    now: () => '2026-06-09T00:00:00Z',
    newRunId: () => 'run_x',
    ...over,
  };
  const lane = createManagerLane(deps);
  return { lane, fr, events };
}

describe('createManagerLane', () => {
  it('runs an enqueued index job and hands the result to onResult', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('bff-web', sink));
    expect(fr.started()).not.toBeNull();
    fr.finish({ result: 'PROFILE' });
    expect(sink).toHaveBeenCalledWith('result', 'bff-web', 'PROFILE');
  });

  it('runs jobs serially: a job enqueued while busy waits its turn', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));            // queued behind a
    expect(fr.started()?.spec.cwd).toBe('/repos/a');
    fr.finish({ result: 'PA' });
    expect(fr.started()?.spec.cwd).toBe('/repos/b'); // b dequeued
    fr.finish({ result: 'PB' });
    expect(sink).toHaveBeenNthCalledWith(1, 'result', 'a', 'PA');
    expect(sink).toHaveBeenNthCalledWith(2, 'result', 'b', 'PB');
  });

  it('treats a non-zero exit as failure and continues to the next job', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));
    fr.finish({ code: 1 });                       // a fails
    expect(sink).toHaveBeenCalledWith('failure', 'a', expect.any(String));
    expect(fr.started()?.spec.cwd).toBe('/repos/b'); // lane moved on
    fr.finish({ result: 'PB' });
    expect(sink).toHaveBeenCalledWith('result', 'b', 'PB');
  });

  it('treats a spawn error (code null, signal null) as failure', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    fr.finish({ code: null, signal: null });
    expect(sink).toHaveBeenCalledWith('failure', 'a', expect.any(String));
  });

  it('treats an empty/absent result on a clean exit as failure', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    fr.finish({ code: 0 });                        // no result captured
    expect(sink).toHaveBeenCalledWith('failure', 'a', expect.any(String));
    expect(sink).not.toHaveBeenCalledWith('result', 'a', expect.anything());
  });

  it('emits starting/running/exited status with the job target', () => {
    const sink = vi.fn();
    const { lane, fr, events } = harness();
    lane.enqueue(indexJob('a', sink));
    fr.finish({ result: 'P' });
    expect(events.map((e) => e.status)).toEqual(['starting', 'running', 'exited']);
    expect(events.every((e) => e.activity === 'indexing' && e.target === 'a')).toBe(true);
    expect(events.at(-1)?.outcome).toBe('success');
  });

  it('reports a current/queued snapshot via isRunning + pending', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    expect(lane.current()).toBeNull();
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));
    expect(lane.current()).toEqual({ activity: 'indexing', target: 'a' });
    expect(lane.queued()).toEqual([{ activity: 'indexing', target: 'b' }]);
    fr.finish({ result: 'P' });
    expect(lane.current()).toEqual({ activity: 'indexing', target: 'b' });
    fr.finish({ result: 'P2' });
    expect(lane.current()).toBeNull();
  });

  it('dispose() stops the active run and clears the queue', async () => {
    const sink = vi.fn();
    const stop = vi.fn(async () => {});
    const fr = fakeRunner();
    fr.runner.stop = stop;
    const { lane } = harness({ createRunner: () => fr.runner });
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));
    await lane.dispose();
    expect(stop).toHaveBeenCalled();
    expect(lane.queued()).toEqual([]);
  });
});
