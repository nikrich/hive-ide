/**
 * Worker process supervisor (slice 2a). Spawns `claude` headless, streams its
 * stream-json output as log lines, and reaps it. One run at a time. The spawn
 * function is injected so tests run without a real `claude`.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import type { HiveRole, HiveRunStatus } from '../../../types/hive';
import { parseClaudeStreamLine } from './stream';

export interface RunSpec {
  runId: string;
  storyId: string;
  role: HiveRole;
  cwd: string;
  taskPrompt: string;
  systemPrompt: string;
  /** Extra env. Defaults to process.env (inherits the user's claude auth). */
  env?: NodeJS.ProcessEnv;
  /** Optional model override. */
  model?: string;
}

export interface RunnerEvents {
  onLog: (line: string) => void;
  onStatus: (s: HiveRunStatus) => void;
  onExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface Runner {
  start(spec: RunSpec, events: RunnerEvents): void;
  stop(runId: string): Promise<void>;
  isBusy(): boolean;
}

/** Grace before SIGKILL after SIGTERM. */
const KILL_GRACE_MS = 5000;

export function buildClaudeArgs(spec: RunSpec): string[] {
  const args = [
    '-p', spec.taskPrompt,
    '--append-system-prompt', spec.systemPrompt,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (spec.model) args.push('--model', spec.model);
  return args;
}

export function createRunner(spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn): Runner {
  let active: { runId: string; child: ChildProcess } | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    isBusy: () => active !== null,

    start(spec, events) {
      if (active !== null) throw new Error('runner is busy: a run is already active');
      events.onStatus('starting');
      const child = spawnFn('claude', buildClaudeArgs(spec), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
      });
      active = { runId: spec.runId, child };
      events.onStatus('running');

      let buf = '';
      let settled = false;
      const finish = (result: { code: number | null; signal: NodeJS.Signals | null }): void => {
        if (settled) return;
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        // flush a residual partial line
        if (buf.trim() !== '') {
          const rendered = parseClaudeStreamLine(buf);
          if (rendered !== null) events.onLog(rendered);
          buf = '';
        }
        active = null;
        events.onStatus('exited');
        events.onExit(result);
      };

      const onChunk = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const rendered = parseClaudeStreamLine(line);
          if (rendered !== null) events.onLog(rendered);
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', (c: Buffer | string) => {
        const s = c.toString().trim();
        if (s !== '') events.onLog(s);
      });

      child.on('error', (err: Error) => {
        events.onLog(`spawn error: ${err.message}`);
        finish({ code: null, signal: null });
      });
      child.on('exit', (code, signal) => {
        finish({ code, signal });
      });
    },

    stop(runId) {
      return new Promise<void>((resolve) => {
        if (active === null || active.runId !== runId) {
          resolve();
          return;
        }
        const { child } = active;
        const done = (): void => resolve();
        child.once('exit', done);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (active?.runId === runId) active.child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        killTimer.unref();
      });
    },
  };
}
