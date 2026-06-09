import { describe, it, expect, vi } from 'vitest';

import { createSupervisor, ACTIVE_TICK_MS, IDLE_TICK_MS, type SupervisorDeps } from './supervisor';

function harness(over: Partial<SupervisorDeps> = {}) {
  let next: (() => void) | null = null;
  let lastMs = -1;
  const deps: SupervisorDeps = {
    getPendingStoryIds: vi.fn(async () => ['S1', 'S2']),
    isRunnerBusy: vi.fn(() => false),
    runStory: vi.fn(async () => {}),
    onStatus: vi.fn(),
    schedule: (ms, fn) => { lastMs = ms; next = fn; },
    ...over,
  };
  const sup = createSupervisor(deps);
  const tick = (): void => { const fn = next; next = null; fn?.(); };
  return { sup, deps, tick, ms: () => lastMs };
}

describe('createSupervisor', () => {
  it('starts the next pending story when the runner is free', async () => {
    const { sup, deps, tick } = harness();
    sup.start();
    tick();
    await Promise.resolve();
    expect(deps.runStory).toHaveBeenCalledWith('S1');
    expect(sup.status()).toEqual({ running: true, currentStory: 'S1' });
  });

  it('does not start a story while the runner is busy', async () => {
    const { sup, deps, tick } = harness({ isRunnerBusy: vi.fn(() => true) });
    sup.start();
    tick();
    await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();
  });

  it('goes idle (currentStory null) when there are no pending stories', async () => {
    const { sup, deps, tick } = harness({ getPendingStoryIds: vi.fn(async () => []) });
    sup.start();
    tick();
    await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();
    expect(sup.status().currentStory).toBeNull();
  });

  it('stop() halts new starts and reports running:false', async () => {
    const { sup, deps, tick } = harness();
    sup.start();
    sup.stop();
    tick();
    await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();
    expect(sup.status().running).toBe(false);
  });

  it('reschedules at the ACTIVE interval after starting a story', async () => {
    const { sup, tick, ms } = harness();
    sup.start(); tick(); await Promise.resolve();
    expect(ms()).toBe(ACTIVE_TICK_MS);
  });

  it('backs off to the IDLE interval when there are no pending stories', async () => {
    const { sup, tick, ms } = harness({ getPendingStoryIds: vi.fn(async () => []) });
    sup.start(); tick(); await Promise.resolve();
    expect(ms()).toBe(IDLE_TICK_MS);
  });

  it('reschedules at the ACTIVE interval while the runner is busy', () => {
    const { sup, tick, ms } = harness({ isRunnerBusy: vi.fn(() => true) });
    sup.start(); tick();
    expect(ms()).toBe(ACTIVE_TICK_MS);
  });

  it('does not double-loop when start() is called twice', () => {
    const schedules: number[] = [];
    let nextFn: (() => void) | null = null;
    const deps: SupervisorDeps = {
      getPendingStoryIds: vi.fn(async () => []),
      isRunnerBusy: vi.fn(() => false),
      runStory: vi.fn(async () => {}),
      onStatus: vi.fn(),
      schedule: (ms, fn) => { schedules.push(ms); nextFn = fn; },
    };
    const sup = createSupervisor(deps);
    sup.start();
    sup.start();              // second start must be a no-op
    void nextFn;
    expect(schedules).toEqual([0]);  // only one initial tick scheduled
  });

  it('does not start a story if stopped while getPendingStoryIds is in flight', async () => {
    let resolvePending: ((ids: string[]) => void) | null = null;
    const { sup, deps, tick } = harness({
      getPendingStoryIds: vi.fn(() => new Promise<string[]>((res) => { resolvePending = res; })),
    });
    sup.start();
    tick();                   // enters the async block, awaits getPendingStoryIds
    sup.stop();               // stop mid-await
    resolvePending?.(['S1']); // now resolve the fetch
    await Promise.resolve(); await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();   // post-await guard prevented it
    expect(sup.status().running).toBe(false);
  });
});
