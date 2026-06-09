/**
 * Main-process bootstrap — REQ-002 / STORY-020.
 *
 * Wires the four slices the renderer reaches over IPC into one app:
 *
 *   - `fs:*`               — STORY-017 (filesystem trust boundary)
 *   - `project:*`          — STORY-018 (project lifecycle + chokidar watcher)
 *   - `state:*`            — STORY-019 (electron-store persistence)
 *   - `shell:open-external` — this story
 *
 * Plus two cross-cutting concerns this story owns:
 *
 *   - Restore the window's last-known bounds from `PersistedState.window`
 *     when we create the BrowserWindow, and push new bounds back into the
 *     store as the user drags / resizes (debounced inside the store).
 *   - On `before-quit`, flush the persisted-state store SYNCHRONOUSLY and
 *     tear down the project watcher so chokidar releases its native file
 *     descriptors.
 *
 * Small file, load-bearing: if any registration is missing the renderer's
 * `ipcRenderer.invoke()` will hang. There's no failsafe further down.
 */

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { registerFsHandlers } from './fs/handlers';
import { registerGitHandlers } from './git/handlers';
import { GitRunner } from './git/runner';
import { registerHiveHandlers } from './hive/handlers';
import {
  registerHiveRunHandlers,
  registerHiveAuthoringHandlers,
  registerHiveLoopHandlers,
  runStory,
  type RunDeps,
} from './hive/run/handlers';
import { createSupervisor } from './hive/run/supervisor';
import { electronNotifier, notifyNeedsInput } from './hive/run/notify';
import { readQuestion, answerQuestion } from './hive/run/question';
import { createRunner } from './hive/run/runner';
import { createWorktree as createWt, hasNewCommit as hasCommit } from './hive/run/worktree';
import { writeRunStart, writeRunFinish } from './hive/run/writer';
import { ensureWorkspace } from './hive/run/workspace';
import { createStory } from './hive/run/story';
import { resolveRepoForStory } from './hive/run/repo';
import { parseStory } from './hive/parse';
import { hiveReader } from './hive/reader';
import { createManagerLane, type ManagerJob } from './hive/manager/lane';
import { serializeProfile, readProfiles } from './hive/manager/profile';
import { buildIndexSystemPrompt, buildIndexPrompt } from './hive/manager/indexer';
import {
  registerHiveManagerHandlers,
  HIVE_MANAGER_EVENTS,
} from './hive/manager/handlers';
import type { IndexStatus, HiveManagerStatusEvent, RepoProfile } from '../types/hive';
import { registerPluginHandlers } from './plugins/handlers';
import { registerLspHandlers } from './plugins/lsp/manager';
import { registerProjectHandlers } from './project/handlers';
import { registerShellHandlers } from './shell/handlers';
import { isHttpUrl } from './shell/validate-url';
import {
  PersistedStateStore,
  registerStateIpc,
  unregisterStateIpc,
} from './state/store';
import { registerTerminalHandlers } from './terminal/handlers';
import {
  attachBoundsPersistence,
  boundsFromState,
  type BoundsWindow,
} from './window/bounds';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

const EVT_HIVE_LOOP_STATUS = 'event:hive:loop:status';
const EVT_HIVE_RUN_QUESTION = 'event:hive:run:question';

// Module-scoped handles so `before-quit` can reach the same instances we
// created during `whenReady`. They start null and are set exactly once.
let store: PersistedStateStore | null = null;
let teardownProjectHandlers: (() => Promise<void>) | null = null;
let teardownShellHandlers: (() => void) | null = null;
let teardownTerminalHandlers: (() => void) | null = null;
let teardownPluginHandlers: (() => void) | null = null;
let teardownLspHandlers: (() => void) | null = null;
let teardownGitHandlers: (() => void) | null = null;
let teardownHiveHandlers: (() => void) | undefined;
let teardownHiveRunHandlers: (() => void) | undefined;
let teardownHiveAuthoringHandlers: (() => void) | undefined;
let teardownHiveLoopHandlers: (() => void) | undefined;
let teardownHiveManagerHandlers: (() => void) | undefined;
let hiveManagerLane: ReturnType<typeof createManagerLane> | null = null;
/** Last-known per-repo index outcome, for the `failed` status (cleared on re-enqueue). */
const hiveIndexFailed = new Set<string>();
let activeHiveRunId: string | null = null;
let hiveRunner: ReturnType<typeof createRunner> | null = null;
let hiveSupervisor: ReturnType<typeof createSupervisor> | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * Wrap a real `BrowserWindow` in the narrow `BoundsWindow` shape that
 * `attachBoundsPersistence` consumes. Avoids importing the Electron type
 * into the helper module (which is unit-tested without Electron).
 */
function asBoundsWindow(win: BrowserWindow): BoundsWindow {
  return {
    isDestroyed: () => win.isDestroyed(),
    getBounds: () => win.getBounds(),
    on: (event, listener) => {
      // Branch per event so each `win.on(...)` lands on the correct
      // Electron overload — the union arg confuses TS's overload picker.
      if (event === 'resize') win.on('resize', listener);
      else win.on('move', listener);
    },
    removeListener: (event, listener) => {
      if (event === 'resize') win.removeListener('resize', listener);
      else win.removeListener('move', listener);
    },
  };
}

function createWindow(persistedStore: PersistedStateStore): void {
  const initial = boundsFromState(persistedStore.get());

  const win = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0B0F1A',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // The store's own 250 ms debounce coalesces the rapid stream of events
  // from a single drag/resize op into one disk write.
  attachBoundsPersistence(
    asBoundsWindow(win),
    () => persistedStore.get(),
    (next) => persistedStore.save(next),
  );

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.on('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'right' });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Mirrors the `shell:open-external` IPC allowlist: an in-page
    // `window.open(...)` from a compromised renderer must not be able to
    // launch arbitrary URI schemes (`file:`, `javascript:`, app
    // protocols). Non-http(s) URLs are silently denied.
    if (isHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // electron-vite emits the renderer to out/renderer/ with index.html at its root.
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // State store first: the window-bounds wiring inside `createWindow`
  // needs it, and `registerStateIpc` binds the renderer to this instance.
  const persistedStore = new PersistedStateStore();
  store = persistedStore;

  registerFsHandlers();
  teardownProjectHandlers = registerProjectHandlers();
  registerStateIpc(persistedStore);
  teardownShellHandlers = registerShellHandlers();
  teardownTerminalHandlers = registerTerminalHandlers();
  teardownPluginHandlers = registerPluginHandlers({
    app,
    hiveVersion: app.getVersion(),
    getMainWindow: () => mainWindow,
  });
  teardownLspHandlers = registerLspHandlers({
    app,
    hiveVersion: app.getVersion(),
    getMainWindow: () => mainWindow,
  });
  teardownGitHandlers = registerGitHandlers();
  teardownHiveHandlers = registerHiveHandlers({ getMainWindow: () => mainWindow });

  const hiveGit = new GitRunner();
  hiveRunner = createRunner();
  const hiveSend = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const activeWorkspacePath = (): string | null => hiveReader.workspacePath();
  const activeRepos = (): import('../types/workspace').Repo[] => {
    const s = store?.get();
    const proj = s && s.lastProjectId ? s.projects[s.lastProjectId] : null;
    return proj?.repos ?? [];
  };
  const hiveRunDeps: RunDeps = {
    getWorkspacePath: activeWorkspacePath,
    getRepoPath: (story) => resolveRepoForStory(story.team, activeRepos()),
    getStory: async (storyId) => {
      const ws = activeWorkspacePath();
      if (!ws) return null;
      try {
        const raw = await readFile(
          join(ws, '.hive', 'state', 'stories', `${storyId}.md`),
          'utf8',
        );
        return parseStory(raw, storyId);
      } catch {
        return null;
      }
    },
    readRoleOverride: async (role) => {
      const ws = activeWorkspacePath();
      if (!ws) return null;
      try {
        return await readFile(join(ws, '.hive', 'skills', `${role}.md`), 'utf8');
      } catch {
        return null;
      }
    },
    createWorktree: (o) => createWt({ git: hiveGit, ...o }),
    hasNewCommit: (wt) => hasCommit(wt),
    writeRunStart: async (o) => {
      activeHiveRunId = o.runId;
      await writeRunStart(o);
    },
    writeRunFinish: async (o) => {
      await writeRunFinish(o);
      if (activeHiveRunId === o.runId) activeHiveRunId = null;
    },
    readQuestion: (workspacePath: string, storyId: string) => readQuestion(workspacePath, storyId),
    onNeedsInput: (q: import('../types/hive').HiveQuestion) => {
      hiveSend(EVT_HIVE_RUN_QUESTION, q);
      notifyNeedsInput(
        electronNotifier(() => {
          if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
        }),
        q,
      );
    },
    runner: hiveRunner,
    send: hiveSend,
    appendRunLog: (runId, line) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      const dir = join(ws, '.hive', 'logs');
      void mkdir(dir, { recursive: true })
        .then(() => appendFile(join(dir, `${runId}.log`), line + '\n', 'utf8'))
        .catch(() => undefined);
    },
    now: () => new Date().toISOString(),
    newRunId: () => `run_${randomUUID().slice(0, 8)}`,
  };
  teardownHiveRunHandlers = registerHiveRunHandlers(hiveRunDeps);

  hiveSupervisor = createSupervisor({
    getPendingStoryIds: async () => {
      const ws = activeWorkspacePath();
      if (!ws) return [];
      try {
        const dir = join(ws, '.hive', 'state', 'stories');
        const names = await readdir(dir);
        const stories = await Promise.all(
          names.filter((n) => n.endsWith('.md')).map(async (n) => {
            const id = n.slice(0, -3);
            try {
              return parseStory(await readFile(join(dir, n), 'utf8'), id);
            } catch {
              return null;
            }
          }),
        );
        return stories
          .filter((s): s is NonNullable<typeof s> => s !== null && s.status === 'pending')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((s) => s.id);
      } catch {
        return [];
      }
    },
    isRunnerBusy: () => (hiveRunner ? hiveRunner.isBusy() : false),
    runStory: (storyId) => runStory(hiveRunDeps, storyId).then(() => undefined),
    onStatus: (s) => hiveSend(EVT_HIVE_LOOP_STATUS, s),
    schedule: (ms, fn) => { const t = setTimeout(fn, ms); t.unref(); },
  });

  teardownHiveLoopHandlers = registerHiveLoopHandlers({
    supervisor: hiveSupervisor,
    answerQuestion: async (storyId, answer) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      await answerQuestion(ws, storyId, answer, new Date().toISOString());
    },
    listQuestions: async () => {
      const ws = activeWorkspacePath();
      if (!ws) return [];
      try {
        const dir = join(ws, '.hive', 'state', 'questions');
        const names = await readdir(dir);
        return Promise.all(
          names.filter((n) => n.endsWith('.md')).map(async (n) => {
            const storyId = n.slice(0, -3);
            const question = (await readQuestion(ws, storyId)) ?? '';
            return { storyId, question };
          }),
        );
      } catch {
        return [];
      }
    },
  });

  // ----- Manager lane (slice 2b-2a): repo indexing ------------------------
  const indexDirFor = (ws: string): string => join(ws, '.hive', 'index');
  const profilePath = (ws: string, repo: string): string =>
    join(indexDirFor(ws), `${repo}.md`);

  /** Best-effort HEAD sha for a repo, or undefined when git is unreachable. */
  const headSha = async (repoPath: string): Promise<string | undefined> => {
    try {
      const { stdout, code } = await hiveGit.run(repoPath, ['rev-parse', '--short', 'HEAD']);
      const sha = stdout.trim();
      return code === 0 && sha ? sha : undefined;
    } catch {
      return undefined;
    }
  };

  const makeIndexJob = (repo: string, repoPath: string): ManagerJob => ({
    activity: 'indexing',
    target: repo,
    buildSpec: (runId) => ({
      runId,
      storyId: repo,            // reused as a label; no story involved
      role: 'manager',
      cwd: repoPath,            // READ-ONLY run in the repo itself; NO worktree
      taskPrompt: buildIndexPrompt(repo),
      systemPrompt: buildIndexSystemPrompt(),
    }),
    onResult: async (text) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      const profile: RepoProfile = {
        repo,
        indexedAt: new Date().toISOString(),
        commit: await headSha(repoPath),
        body: text,
      };
      const dir = indexDirFor(ws);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(profilePath(ws, repo), serializeProfile(profile), 'utf8');
        hiveIndexFailed.delete(repo);
      } catch (err) {
        hiveIndexFailed.add(repo);
        const detail = err instanceof Error ? err.message : 'write error';
        hiveSend(HIVE_MANAGER_EVENTS.status, {
          activity: 'indexing',
          target: repo,
          status: 'exited',
          outcome: 'failure',
          detail,
        } satisfies HiveManagerStatusEvent);
      }
    },
    onFailure: () => {
      hiveIndexFailed.add(repo);
    },
  });

  hiveManagerLane = createManagerLane({
    onStatus: (e: HiveManagerStatusEvent) => hiveSend(HIVE_MANAGER_EVENTS.status, e),
    now: () => new Date().toISOString(),
    newRunId: () => `idx_${randomUUID().slice(0, 8)}`,
  });

  /** Enqueue an index job for one repo by name (no-op if unknown / no ws). */
  const reindexRepo = async (repo: string): Promise<void> => {
    if (!activeWorkspacePath()) return;
    const r = activeRepos().find((x) => x.name === repo);
    if (!r) return;
    hiveIndexFailed.delete(repo);
    hiveManagerLane?.enqueue(makeIndexJob(repo, r.path));
  };

  /** Enqueue index jobs for every repo that has no profile yet. */
  const autoIndexUnindexed = async (): Promise<void> => {
    const ws = activeWorkspacePath();
    if (!ws) return;
    const profiles = await readProfiles(indexDirFor(ws));
    const have = new Set(profiles.map((p) => p.repo));
    const inFlight = new Set<string>([
      ...(hiveManagerLane?.current() ? [hiveManagerLane.current()!.target] : []),
      ...((hiveManagerLane?.queued() ?? []).map((q) => q.target)),
    ]);
    for (const r of activeRepos()) {
      if (!have.has(r.name) && !inFlight.has(r.name)) {
        hiveManagerLane?.enqueue(makeIndexJob(r.name, r.path));
      }
    }
  };

  const computeIndexStatus = async (): Promise<Record<string, IndexStatus>> => {
    const ws = activeWorkspacePath();
    const out: Record<string, IndexStatus> = {};
    if (!ws) return out;
    const profiles = await readProfiles(indexDirFor(ws));
    const have = new Set(profiles.map((p) => p.repo));
    const running = hiveManagerLane?.current();
    const queuedTargets = new Set((hiveManagerLane?.queued() ?? []).map((q) => q.target));
    for (const r of activeRepos()) {
      const name = r.name;
      const isRunning = running?.activity === 'indexing' && running.target === name;
      if (isRunning || queuedTargets.has(name)) out[name] = 'indexing';
      else if (have.has(name)) out[name] = 'indexed';
      else if (hiveIndexFailed.has(name)) out[name] = 'failed';
      else out[name] = 'unindexed';
    }
    return out;
  };

  teardownHiveManagerHandlers = registerHiveManagerHandlers({
    reindex: reindexRepo,
    indexStatus: computeIndexStatus,
  });

  // Index any repos that have no profile yet, on app start.
  void autoIndexUnindexed();

  teardownHiveAuthoringHandlers = registerHiveAuthoringHandlers({
    userDataPath: () => app.getPath('userData'),
    ensureWorkspace,
    setReaderWorkspace: async (workspacePath) => {
      await hiveReader.setWorkspace(workspacePath);
      void autoIndexUnindexed();
    },
    createStory,
    now: () => new Date().toISOString(),
  });

  createWindow(persistedStore);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(persistedStore);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // SYNCHRONOUS work first — once the process unwinds we lose the ability
  // to write to disk. The store's `flush()` is sync (electron-store sets
  // are sync) and persists any pending debounced save.
  const persistedStore = store;
  store = null;
  if (persistedStore !== null) {
    persistedStore.flush();
    unregisterStateIpc();
  }

  if (teardownShellHandlers !== null) {
    teardownShellHandlers();
    teardownShellHandlers = null;
  }

  if (teardownPluginHandlers !== null) {
    teardownPluginHandlers();
    teardownPluginHandlers = null;
  }

  // LSP teardown disposes every running language-server child. SIGTERM
  // first; SIGKILL after a 5 s grace inside the wrapper.
  if (teardownLspHandlers !== null) {
    teardownLspHandlers();
    teardownLspHandlers = null;
  }

  // Git handlers are pure IPC registrations (the runner spawns short-lived
  // child processes per call and they exit before we do); just remove
  // them so a hot-reload doesn't double-register.
  if (teardownGitHandlers !== null) {
    teardownGitHandlers();
    teardownGitHandlers = null;
  }

  teardownHiveHandlers?.();

  if (hiveSupervisor) hiveSupervisor.stop();
  hiveSupervisor = null;
  teardownHiveLoopHandlers?.();
  teardownHiveLoopHandlers = undefined;

  teardownHiveManagerHandlers?.();
  teardownHiveManagerHandlers = undefined;
  if (hiveManagerLane) void hiveManagerLane.dispose();
  hiveManagerLane = null;

  teardownHiveRunHandlers?.();
  teardownHiveRunHandlers = undefined;
  teardownHiveAuthoringHandlers?.();
  teardownHiveAuthoringHandlers = undefined;
  if (activeHiveRunId && hiveRunner) void hiveRunner.stop(activeHiveRunId);
  hiveRunner = null;

  // Terminal teardown kills every live pty so the OS reclaims the slave
  // file descriptors. Synchronous — see `registerTerminalHandlers`.
  if (teardownTerminalHandlers !== null) {
    teardownTerminalHandlers();
    teardownTerminalHandlers = null;
  }

  // Project watchers (chokidar) close asynchronously. Fire-and-forget;
  // Electron gives a tick of grace before terminating which is enough on
  // macOS/Linux for the close promises to drain. STORY-018's handler
  // teardown also removes its IPC registrations.
  const projectTeardown = teardownProjectHandlers;
  teardownProjectHandlers = null;
  if (projectTeardown !== null) void projectTeardown();
});
