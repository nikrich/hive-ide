# Hive E2E Suite (Playwright + Electron) — Design

**Date:** 2026-06-10
**Status:** Approved (brainstormed in-session)
**Scope:** PR 1 of 3 (e2e harness + suites → GitHub-enriched PRs view → audit-driven UI polish). This spec covers only PR 1.

## Goal

A committed Playwright e2e suite that launches the real Electron app against fixture `.hive` workspaces and verifies the orchestration surface (board, roster, chat, needs-input, requirement approval, event log, PRs view) plus the shipped parity features (hunk staging, replace opt-out, references) end-to-end — locally via `npm run e2e` and in CI.

## Why this approach

Three candidates were considered:

1. **Playwright `_electron.launch` on the built app** *(chosen)* — drives the real main + preload + renderer with first-class Electron support; deterministic (no dev-server HMR, no React StrictMode double-mount noise); CI-able under xvfb.
2. CDP-attach to the dev server (the interactive smoke approach) — proved the flows manually but is port-fragile, inherits dev-mode noise, and can't seed isolated state safely.
3. Renderer-only tests with a mocked `window.hive` bridge — fast but skips IPC, main-process handlers, and the file-watch pipeline, which is exactly where orchestration lives.

## Product change required (testability hook)

`src/main/index.ts` honors a `HIVE_USER_DATA_DIR` environment variable: when set, call `app.setPath('userData', value)` **before** any module reads the path (i.e. at the top of the bootstrap, before `app.whenReady()` resolves and before `PersistedStateStore`/settings construct). Guarded to absolute paths; ignored when unset.

This is what lets every test run in a throwaway userData sandbox — the manual smoke runs had to back up and restore the developer's real `workspace.json`, which is not acceptable for an automated suite.

## Architecture

```
e2e/
  playwright.config.ts      # testDir e2e/specs, workers:1, retries: CI?1:0,
                            # trace+screenshot on first retry / failure
  helpers/
    app.ts                  # launchApp(fixture): builds temp userData, writes
                            #   seeded workspace.json, _electron.launch(out/main),
                            #   returns { app, window }; closeApp() teardown.
                            # Attaches a console/pageerror listener; uncaught
                            #   renderer errors FAIL the test (filtered allowlist:
                            #   the optional .hive/extensions.json ENOENT log).
    ui.ts                   # tiny selector helpers built on existing aria-labels
                            #   (rail buttons, dock tabs, hunkbar buttons,
                            #   search checkboxes) — no new test-ids unless a
                            #   surface has no accessible handle.
  fixtures/
    hive.ts                 # makeFixture(opts): mktemp project dir containing
                            #   - git repo: committed app.js/notes.txt/lib.ts,
                            #     working-tree edits forming two separated hunks
                            #   - .hive/state/{stories,agents,requirements}/*.md
                            #     (YAML frontmatter per src/main/hive/parse.ts)
                            #   - .hive/events.ndjson, .hive/chat.ndjson
                            #   plus mutators: appendEvent(), appendChat(),
                            #   writeStory(), and a seededWorkspaceJson(projectId)
                            #   builder including openTabs: [] (full session shape).
  specs/
    orchestration.spec.ts
    parity.spec.ts
```

Launch target is the **built app**: `npm run build` produces `out/`; tests run `_electron.launch({ args: ['.'], cwd: <worktree>, env: { HIVE_USER_DATA_DIR } })` using the repo's `main` entry (electron resolves `out/main/index.js` via package.json). One fresh app instance per test (workers=1); target suite runtime < 5 minutes.

**No real agents are spawned.** Orchestration state transitions are simulated by mutating fixture files mid-test, which exercises the real chokidar → debounce → IPC push → zustand → React pipeline. Waits use `expect.poll`/locator auto-waiting on UI state — no fixed sleeps.

## Suite contents

### orchestration.spec.ts
| Test | Drives | Asserts |
|---|---|---|
| connects to the fixture workspace | boot | "Connected · <path>" ribbon in the Dock |
| board reflects story statuses | stories with pending/in-progress/review/merged | each lands in its column; proposed/needs-input excluded |
| roster reflects agents | one live + one exited agent file | names/status chips |
| event log streams | `appendEvent()` mid-test | new line appears in manager.log without reload |
| chat round-trip | type + Enter; then `appendChat(manager)` | ndjson line written by app; manager bubble appears live |
| needs-input answer flow | story with status needs-input + pushed question | card renders; typing an answer + Send calls the loop bridge (assert via the answer side-effect the handler writes) |
| requirement approval gate | requirement + proposed stories | cards render grouped; Approve transitions the proposed story out of proposed (file change observed) |
| PRs view | story with `pr_url` | card fields (#num, role, branch, status chip, Open button); empty state when no prUrl stories |
| clean console | all of the above | zero uncaught renderer errors (helper-enforced globally) |

The needs-input and approval rows depend on what the existing IPC handlers actually write; the implementation plan locks the exact assertions after reading `loop.answer` / `manager.approve` handler code. If a flow turns out to require a live worker process (not just file state), the test asserts up to the IPC boundary and stops — no stub worker binary in this PR (that was the rejected "include the run loop" scope).

### parity.spec.ts
| Test | Asserts |
|---|---|
| stage hunk 1 | `git diff --cached` contains exactly hunk one; hunkbar drops to one row |
| unstage from index diff | index empty after; working tree intact |
| replace with one match excluded | disk shows excluded line untouched, others replaced |
| all matches excluded | warning notification; no disk writes |
| ⇧F12 on TS symbol | references panel shows the hit |

## CI

New `e2e` job in `.github/workflows/ci.yml`: ubuntu-latest, needs the existing build (or rebuilds), `npx playwright install chromium --with-deps` is **not** needed (Electron ships its own binary); run `xvfb-run -a npx playwright test`. Upload `playwright-report/` + traces as an artifact on failure. The job is required for merge like the existing CI job.

## Error handling & flakiness policy

- Per-test fresh Electron instance; temp dirs removed in teardown (kept on failure for the trace artifact).
- The console-error listener turns renderer regressions (like the two fixed in #55) into test failures, with an explicit allowlist for known-benign dev noise.
- Acceptance: 3 consecutive green local runs + green CI before the PR is marked ready.

## Out of scope (later PRs)

- GitHub API enrichment of the PRs view (PR 2 — has its own design questions: token source, caching, rate limits).
- UI polish items (PR 3 — audit first, then an approved fix list).
- Stubbed-worker run-loop e2e (explicitly rejected for flakiness; revisit if PR 2/3 work surfaces a need).
