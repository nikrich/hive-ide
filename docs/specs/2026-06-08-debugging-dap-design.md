# Debugging (DAP) — Design Spec

**Backlog:** Epic 3 (E3-01..E3-14). The backlog requires this spec before E3-01.
**Status of foundations (this branch):** DAP message codec (`src/main/debug/dapCodec.ts`),
`launch.json` schema + JSONC loader (`lib/launchConfig.ts`), breakpoint store +
gutter (`store/breakpointsStore.ts`) — all landed + tested.

## Goal
Run/debug a program from the IDE: set breakpoints, launch via `launch.json`,
hit a breakpoint, inspect call stack + variables, step, and evaluate in a debug
console — for a first concrete adapter (Node.js).

## Architecture (mirrors the LSP bridge)

```
renderer (debug UI + stores)
   │  IPC: debug:start/stop/continue/step*/evaluate/setBreakpoints
   │  push: event:debug:{stopped,output,terminated,thread,scopes,...}
main (DebugSession manager)
   │  spawn adapter child process (stdio)
   │  DapMessageReader / encodeMessage  ← already built + tested
adapter process (e.g. js-debug)  ──DAP──>  debuggee
```

- **`src/main/debug/session.ts`** — `DebugSession`: spawns the adapter, runs the
  `initialize` → `launch`/`attach` → `configurationDone` handshake, sequences
  requests (`seq` counter + pending-response map), and forwards adapter *events*
  to the renderer over IPC. One active session in v1 (backlog E3-01).
- **`src/main/debug/handlers.ts`** — `registerDebugHandlers`: `debug:start(config)`,
  `debug:stop`, `debug:continue/next/stepIn/stepOut/pause`, `debug:setBreakpoints`,
  `debug:stackTrace`, `debug:scopes`, `debug:variables`, `debug:evaluate`. Each
  maps to a DAP request; results returned to the caller. Adapter events
  (`stopped`, `output`, `terminated`, `exited`) pushed via `event:debug:*`.
- **preload** — `window.hive.debug` bridge mirroring the LSP bridge shape
  (request/response + id-less push subscriptions).
- **renderer stores** — `debugStore` (session state: status, threads, current
  frame, stack, scopes, variables, console output); breakpoints already exist.
- **renderer UI** — debug toolbar (continue/step/restart/stop), Call Stack +
  Variables + Watch views (a new activity-bar "Run and Debug" view or a
  bottom-panel set), Debug Console (reuse the panel framework), current-line
  highlight + inline values on stop.

## Decisions to make (the product calls these)

1. **First adapter (E3-14).** Options:
   - **`js-debug` (vscode-js-debug)** — the adapter VSCode ships for Node. Most
     capable; obtained as a downloaded bundle (fits the existing plugin
     `setup.downloads` mechanism — REQ-007). **Recommended.**
   - Node's legacy `--inspect` + a thin DAP shim — lighter but more to maintain.
   - Decision: ship `js-debug` via a built-in "debuggers" contribution, fetched
     on first use like jdtls is for LSP.
2. **Adapter delivery.** Reuse plugin `setup.downloads` (sha256-verified, cached
   under plugin storage) so adapters are not bundled in the app binary.
3. **Plugin debuggers (E3-12 / E10-06).** `contributes.debuggers` in plugin.json:
   `{ type, label, program (adapter entry), runtime }`. The session manager
   resolves `config.type` → a registered debugger contribution.

## Phasing
1. `DebugSession` + handlers + preload + `debugStore` (E3-01) — launch a config,
   handshake, forward `stopped`/`output`/`terminated`.
2. Send breakpoints on launch + on change (E3-03 already stores them).
3. Toolbar + stepping (E3-04), Call Stack (E3-05), Variables (E3-06), Console
   (E3-07).
4. Watch (E3-08), inline values (E3-09), conditional/logpoints (E3-10),
   exception breakpoints (E3-11).
5. `contributes.debuggers` (E3-12) + bundled Node adapter wiring (E3-14).

## Testing
- Codec already unit-tested. `DebugSession` request sequencing + event routing
  unit-tested with a fake adapter (a scripted stdio stream). An end-to-end
  smoke test launches a tiny Node script under the real adapter and asserts a
  breakpoint `stopped` event — gated behind adapter availability.
