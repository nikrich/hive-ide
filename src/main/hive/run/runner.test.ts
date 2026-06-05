import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { createRunner, type RunSpec, type SpawnFn } from './runner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}

const spec: RunSpec = {
  runId: 'run_1', storyId: 'AUTH-3', role: 'senior', cwd: '/wt',
  taskPrompt: 'do it', systemPrompt: 'be senior',
};

describe('createRunner', () => {
  it('streams parsed log lines and reports exit', () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child as never);
    const runner = createRunner(spawnFn);
    const logs: string[] = [];
    const statuses: string[] = [];
    let exit: { code: number | null } | null = null;
    runner.start(spec, {
      onLog: (l) => logs.push(l),
      onStatus: (s) => statuses.push(s),
      onExit: (r) => { exit = r; },
    });
    expect(runner.isBusy()).toBe(true);
    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    ));
    child.emit('exit', 0, null);
    expect(logs).toContain('hi');
    expect(statuses).toContain('running');
    expect(statuses).toContain('exited');
    expect(exit).toEqual({ code: 0, signal: null });
    expect(runner.isBusy()).toBe(false);
  });

  it('rejects a second start while busy', () => {
    const spawnFn: SpawnFn = vi.fn(() => fakeChild() as never);
    const runner = createRunner(spawnFn);
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} });
    expect(() => runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} })).toThrow(/busy/i);
  });

  it('stop() sends SIGTERM to the child', async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child as never);
    const runner = createRunner(spawnFn);
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} });
    const p = runner.stop('run_1');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await p;
  });

  it('passes the expected claude args + cwd to spawn', () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child as never) as unknown as SpawnFn;
    const runner = createRunner(spawnFn);
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} });
    const call = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const cmd = call[0]; const args = call[1]; const opts = call[2];
    expect(cmd).toBe('claude');
    expect(args).toEqual(expect.arrayContaining([
      '-p', 'do it', '--append-system-prompt', 'be senior',
      '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose',
    ]));
    expect(opts.cwd).toBe('/wt');
  });
});
