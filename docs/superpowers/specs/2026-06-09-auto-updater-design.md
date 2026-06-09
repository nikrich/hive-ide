# In-app updater — design

_2026-06-09 · branch `feat/auto-updater`_

## Goal

Let Hive IDE update itself. The app already ships signed/unsigned installers to
GitHub Releases via electron-builder's `github` publish provider, so the release
metadata `electron-updater` needs (`latest.yml`, `latest-mac.yml`,
`latest-linux.yml`, `*.blockmap`) is already published. This feature wires the
client side: detect, download, and install new releases from inside the app.

## Behaviour (approved)

- **Auto-download + prompt to restart.** On launch (after a short delay) and on a
  periodic interval, check GitHub for a newer release. Download it silently in
  the background. When the download completes, show a **persistent**, dismissible
  banner: _"Hive IDE {version} is ready — Restart to update."_ The user chooses
  when to restart; we never force-install while the app is running.
- **Manual controls:** a **"Check for updates"** command in the ⌘K command
  palette, and the current app version surfaced in the palette.

## Non-goals (YAGNI)

- No settings toggle to disable auto-update (always on).
- No native OS menu item / native dialogs.
- No staged/percentage rollout, no changelog rendering, no delta-only logic
  beyond what electron-updater does for free.
- No build-config changes — `electron-builder.config.cjs` already embeds the
  GitHub provider, so packaged apps get `app-update.yml` automatically.

## Architecture

Follows the repo's existing main-process module shape (`src/main/<feature>/` with
module-scoped channel constants, a `registerXHandlers()` that returns a teardown
closure, and colocated `*.test.ts`).

### New main module: `src/main/updater/`

**`updater.ts`** — thin wrapper around `electron-updater`'s `autoUpdater`.
- Config: `autoDownload = true`, `autoInstallOnAppQuit = false` (we prompt),
  logger wired to the app's logging.
- `initAutoUpdater({ resolveWindow })` — attaches listeners for
  `checking-for-update`, `update-available`, `update-not-available`,
  `download-progress`, `update-downloaded`, `error`; maps each to an
  `UpdaterStatus` object and pushes it to the renderer via the active window's
  `webContents.send(UPDATER_CHANNELS.status, status)`.
- `checkForUpdates()` — triggers `autoUpdater.checkForUpdates()`; safe to call
  manually. In a non-packaged (dev) process it short-circuits to an
  `unsupported` status instead of throwing.
- `quitAndInstall()` — calls `autoUpdater.quitAndInstall()`.

**`handlers.ts`**
```
UPDATER_CHANNELS = {
  check:          'updater:check',            // renderer → main (invoke)
  quitAndInstall: 'updater:quit-and-install', // renderer → main (invoke)
  getVersion:     'updater:get-version',      // renderer → main (invoke)
  status:         'updater:status',           // main → renderer (event)
}
```
- `registerUpdaterHandlers({ app, resolveWindow })` registers the three
  invoke handlers and returns a teardown closure removing them (same contract as
  `plugins/handlers.ts`). `getVersion` returns `app.getVersion()`.

### Wiring: `src/main/index.ts`

- Always call `registerUpdaterHandlers(...)` (so manual check works everywhere).
- Only when `app.isPackaged`: call `initAutoUpdater(...)`, run a first check
  ~10s after the window is ready, and schedule a repeat check every 6 hours.
- In dev, auto-checks are skipped; a manual check reports the `unsupported`
  status so the UI can say "updates only run in packaged builds."

### Preload: `src/preload/api.ts`

Add a `updater` namespace to `window.hive`:
```
updater: {
  check(): Promise<void>
  quitAndInstall(): Promise<void>
  getVersion(): Promise<string>
  onStatus(cb: (s: UpdaterStatus) => void): () => void  // returns unsubscribe
}
```
`onStatus` is the first main→renderer subscription in the bridge; implemented with
`ipcRenderer.on(UPDATER_CHANNELS.status, …)` and a matching `removeListener` in the
returned unsubscribe.

`UpdaterStatus` (shared type, defined in `src/preload/api.ts` alongside the other
bridge types):
```
type UpdaterPhase =
  | 'idle' | 'checking' | 'available' | 'downloading'
  | 'downloaded' | 'not-available' | 'error' | 'unsupported'
interface UpdaterStatus {
  phase: UpdaterPhase
  version?: string     // target version when known
  percent?: number     // 0–100 during 'downloading'
  error?: string       // message when phase === 'error'
}
```

### Renderer

- **`store/updater.ts`** (Zustand, mirrors `store/recents.ts`) — subscribes to
  `window.hive.updater.onStatus` once on init, holds the latest `UpdaterStatus`,
  and exposes `check()` / `quitAndInstall()` passthroughs plus the resolved
  `version`.
- **`components/UpdateBanner.tsx`** — renders only when `phase === 'downloaded'`.
  Persistent (unlike `Toast.tsx`, which auto-dismisses): message + **Restart to
  update** button (→ `quitAndInstall()`) + dismiss. Styled with existing tokens
  (`--bg-elevated`, `--border-default`, …) via `ide.css`. Mounted at app shell
  level so it survives view changes.
- **`CommandPalette.tsx`** — add a "Check for updates" command invoking
  `check()`, and show the current version (from the store) in the palette.

## Error handling

- `autoUpdater` `error` events become `phase: 'error'` with the message; the UI
  stays quiet for background failures (no nag toast) but a manual check surfaces
  the error in the palette. Network errors are non-fatal — the next scheduled
  check retries.
- Dev / non-packaged: `unsupported` phase, never throws.
- macOS unsigned builds: download succeeds but `quitAndInstall` cannot complete
  an unsigned update — documented limitation (see below), not handled in code.

## Known limitations (documented, not solved)

- **macOS auto-install requires a signed build.** The CI signing is conditional;
  unsigned mac builds can download an update but cannot self-install it. Windows
  (NSIS) and Linux (AppImage) update normally.

## Testing (TDD, Vitest)

- `updater/updater.test.ts` — mock `electron-updater`'s `autoUpdater`: event →
  `UpdaterStatus` mapping, the dev `unsupported` short-circuit, `autoDownload`/
  `autoInstallOnAppQuit` config, `quitAndInstall` passthrough.
- `updater/handlers.test.ts` — channel registration + teardown removes handlers;
  `getVersion` returns `app.getVersion()` (same style as `plugins/handlers.test.ts`).
- `store/updater.test.ts` — subscribes to a mocked `window.hive.updater`, updates
  state on pushed status, passthroughs call the bridge.
- `components/UpdateBanner.test.tsx` — hidden unless `downloaded`; Restart button
  calls `quitAndInstall`.

## Build / release impact

None. No changes to `electron-builder.config.cjs` or the release workflow. The
only dependency added is `electron-updater`.
