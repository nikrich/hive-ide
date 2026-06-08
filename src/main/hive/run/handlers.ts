/**
 * Worker-run orchestration + IPC (slice 2a). `runStory` composes the units into
 * the create-worktree → start-write → spawn → reap → finish-write sequence and
 * is dependency-injected for tests. `registerHiveRunHandlers` wires it to IPC.
 */

import { ipcMain } from 'electron';

import type {
  HiveRole,
  HiveRunStatusEvent,
  HiveRunLogEvent,
  HiveStory,
  HiveQuestion,
  NewStoryFields,
} from '../../../types/hive';
import { resolveRolePrompt, buildTaskPrompt } from './prompt';
import type { Worktree } from './worktree';
import type { Runner } from './runner';

export const HIVE_RUN_CHANNELS = {
  start: 'ipc:hive:run:start',
  stop: 'ipc:hive:run:stop',
} as const;

export const HIVE_RUN_EVENTS = {
  log: 'event:hive:run:log',
  status: 'event:hive:run:status',
} as const;

export const HIVE_AUTHORING_CHANNELS = {
  ensureWorkspace: 'ipc:hive:ensure-workspace',
  createStory: 'ipc:hive:create-story',
} as const;

type Outcome =
  | { kind: 'success' } | { kind: 'no-commit' } | { kind: 'failure' }
  | { kind: 'interrupted' } | { kind: 'needs-input' };

export interface RunDeps {
  getWorkspacePath: () => string | null;
  getRepoPath: (story: HiveStory) => string | null;
  getStory: (storyId: string) => Promise<HiveStory | null>;
  /** Contents of <ws>/.hive/skills/<role>.md, or null. */
  readRoleOverride: (role: HiveRole) => Promise<string | null>;
  createWorktree: (opts: {
    repoPath: string; workspacePath: string; storyId: string; branch: string;
  }) => Promise<Worktree>;
  hasNewCommit: (wt: Worktree) => Promise<boolean>;
  /** Read a pending question file written by the worker, or null. */
  readQuestion: (workspacePath: string, storyId: string) => Promise<string | null>;
  /** Notify the operator a worker is blocked on a question. */
  onNeedsInput: (q: HiveQuestion) => void;
  writeRunStart: (opts: {
    workspacePath: string; story: HiveStory; runId: string; featureBranch: string;
    worktree: string; pid: number | undefined; now: string;
  }) => Promise<void>;
  writeRunFinish: (opts: {
    workspacePath: string; storyId: string; runId: string; outcome: Outcome; now: string;
  }) => Promise<void>;
  runner: Runner;
  send: (channel: string, payload: HiveRunLogEvent | HiveRunStatusEvent) => void;
  /** Best-effort append of a rendered log line to the per-run log file. */
  appendRunLog: (runId: string, line: string) => void;
  now: () => string;
  newRunId: () => string;
}

let runInFlight = false;

export async function runStory(deps: RunDeps, storyId: string): Promise<{ runId: string }> {
  if (runInFlight || deps.runner.isBusy()) throw new Error('A run is already active (runner busy)');
  runInFlight = true;
  try {
    const workspacePath = deps.getWorkspacePath();
    if (!workspacePath) throw new Error('No connected hive workspace');

    const story = await deps.getStory(storyId);
    if (!story) throw new Error(`Story not found: ${storyId}`);

    const repoPath = deps.getRepoPath(story);
    if (!repoPath) throw new Error('No repo for story (project has no repos)');

    const runId = deps.newRunId();
    const branch = story.featureBranch ?? `feat/${storyId}`;

    const wt = await deps.createWorktree({ repoPath, workspacePath, storyId, branch });

    await deps.writeRunStart({
      workspacePath, story, runId, featureBranch: branch,
      worktree: wt.path, pid: undefined, now: deps.now(),
    });

    const systemPrompt = resolveRolePrompt(story.role, await deps.readRoleOverride(story.role));
    const taskPrompt = buildTaskPrompt(story, {
      repoName: story.team,
      featureBranch: branch,
      workspacePath,
    });

    const status = (s: HiveRunStatusEvent['status'], extra: Partial<HiveRunStatusEvent> = {}): void =>
      deps.send(HIVE_RUN_EVENTS.status, { runId, storyId, status: s, ...extra });

    await new Promise<void>((resolve) => {
      deps.runner.start(
        { runId, storyId, role: story.role, cwd: wt.path, taskPrompt, systemPrompt },
        {
          onLog: (line) => {
            deps.send(HIVE_RUN_EVENTS.log, { runId, line });
            deps.appendRunLog(runId, line);
          },
          onStatus: (s) => status(s),
          onExit: (result) => {
            void (async () => {
              let outcome: Outcome;
              const question = await deps.readQuestion(workspacePath, storyId);
              if (question !== null) {
                outcome = { kind: 'needs-input' };
                deps.onNeedsInput({ storyId, question });
              } else if (result.signal !== null) {
                outcome = { kind: 'interrupted' };
              } else if (result.code === 0) {
                outcome = (await deps.hasNewCommit(wt)) ? { kind: 'success' } : { kind: 'no-commit' };
              } else {
                outcome = { kind: 'failure' };
              }
              try {
                await deps.writeRunFinish({ workspacePath, storyId, runId, outcome, now: deps.now() });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('hive run: writeRunFinish failed', err);
              }
              status('exited', { outcome: outcome.kind });
              resolve();
            })();
          },
        },
      );
    });

    return { runId };
  } finally {
    runInFlight = false;
  }
}

export function registerHiveRunHandlers(deps: RunDeps): () => void {
  ipcMain.handle(HIVE_RUN_CHANNELS.start, (_e, args: { storyId: string }) =>
    runStory(deps, args.storyId),
  );
  ipcMain.handle(HIVE_RUN_CHANNELS.stop, (_e, args: { runId: string }) =>
    deps.runner.stop(args.runId),
  );
  return () => {
    ipcMain.removeHandler(HIVE_RUN_CHANNELS.start);
    ipcMain.removeHandler(HIVE_RUN_CHANNELS.stop);
  };
}

export interface AuthoringDeps {
  userDataPath: () => string;
  ensureWorkspace: (userDataPath: string, projectId: string) => Promise<string>;
  /** Point the slice-1 reader at the workspace so the board goes live. */
  setReaderWorkspace: (workspacePath: string) => Promise<void>;
  createStory: (workspacePath: string, fields: NewStoryFields, now: string) => Promise<string>;
  now: () => string;
}

export async function ensureWorkspaceFor(
  deps: AuthoringDeps,
  projectId: string,
): Promise<{ workspacePath: string }> {
  const workspacePath = await deps.ensureWorkspace(deps.userDataPath(), projectId);
  await deps.setReaderWorkspace(workspacePath);
  return { workspacePath };
}

export async function createStoryFor(
  deps: AuthoringDeps,
  workspacePath: string,
  fields: NewStoryFields,
): Promise<{ storyId: string }> {
  const storyId = await deps.createStory(workspacePath, fields, deps.now());
  return { storyId };
}

export function registerHiveAuthoringHandlers(deps: AuthoringDeps): () => void {
  ipcMain.handle(HIVE_AUTHORING_CHANNELS.ensureWorkspace, (_e, args: { projectId: string }) =>
    ensureWorkspaceFor(deps, args.projectId),
  );
  ipcMain.handle(HIVE_AUTHORING_CHANNELS.createStory, (_e, args: { workspacePath: string; fields: NewStoryFields }) =>
    createStoryFor(deps, args.workspacePath, args.fields),
  );
  return () => {
    ipcMain.removeHandler(HIVE_AUTHORING_CHANNELS.ensureWorkspace);
    ipcMain.removeHandler(HIVE_AUTHORING_CHANNELS.createStory);
  };
}
