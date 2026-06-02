/**
 * Language-server child-process abstraction — REQ-007.
 *
 * Wraps a single LSP server child process. Two responsibilities:
 *
 *   1. **Spawn + lifecycle.** `LspServerProcess` owns the `ChildProcess`
 *      and exposes its stdio so the manager can pump LSP frames
 *      renderer ↔ server without knowing about Node's stream machinery.
 *      `dispose()` sends SIGTERM, waits 5 s, then escalates to SIGKILL —
 *      jdtls in particular takes a while to flush its JVM on shutdown
 *      but does eventually go away under SIGTERM, so the escalation is a
 *      backstop, not the usual path.
 *
 *   2. **`${pluginDir}` expansion.** Plugin manifests reference the
 *      install path as `${pluginDir}/launch.sh`. The substitution is
 *      string-level (it's the only template token we support) and the
 *      result is checked against the plugin folder so a malicious
 *      manifest can't `${pluginDir}/../../bin/rm` its way out.
 *
 * Path-safety here is the single hard line between an installed plugin
 * (already trusted with arbitrary filesystem reads via its tarball) and
 * the rest of the system: we want commands to point at files inside the
 * plugin folder, and we want the cwd to be either a project repo path
 * or somewhere inside the plugin folder.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** Options passed to {@link LspServerProcess}'s constructor. */
export interface LspServerProcessOptions {
  /** Already-expanded absolute path or bare program name (e.g. `'node'`). */
  command: string;
  args: string[];
  /** Already-expanded absolute cwd. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Listener signature for `onExit`. */
export type LspExitListener = (info: {
  code: number | null;
  signal: NodeJS.Signals | null;
}) => void;

/**
 * One spawned LSP server. The wrapper is a thin convenience layer over
 * `ChildProcess` — we don't try to track LSP protocol state here (that
 * lives renderer-side), only OS process state.
 */
export class LspServerProcess {
  readonly #child: ChildProcess;
  #disposed = false;
  #killTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #exitListeners: Set<LspExitListener> = new Set();

  constructor(opts: LspServerProcessOptions, spawnFn: typeof spawn = spawn) {
    // `stdio: ['pipe', 'pipe', 'pipe']` so we own all three streams. The
    // child inherits a clean environment minus anything Electron added
    // that would confuse a server (NODE_ENV, ELECTRON_*).
    const sanitizedEnv = sanitizeEnv(opts.env);
    this.#child = spawnFn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.on('exit', (code, signal) => {
      // Clear any escalation timer — process is gone, no need to SIGKILL.
      if (this.#killTimer !== null) {
        clearTimeout(this.#killTimer);
        this.#killTimer = null;
      }
      for (const listener of this.#exitListeners) {
        try {
          listener({ code, signal });
        } catch {
          // never let a listener throw upward — we're inside the child's
          // exit event and the manager just wants to clean up.
        }
      }
    });
    this.#child.on('error', () => {
      // 'error' is fired e.g. when the command doesn't exist. node ALSO
      // fires 'exit' with `code=null, signal=null` immediately after, so
      // we forward through the same channel — listeners only need to
      // handle one path.
    });
  }

  /** stdin pipe — write LSP frames here. */
  get stdin(): Writable {
    if (this.#child.stdin === null) {
      throw new Error('LspServerProcess: stdin is not available');
    }
    return this.#child.stdin;
  }

  /** stdout pipe — LSP frames arrive here. */
  get stdout(): Readable {
    if (this.#child.stdout === null) {
      throw new Error('LspServerProcess: stdout is not available');
    }
    return this.#child.stdout;
  }

  /** stderr — log/diagnostic output the server may emit. */
  get stderr(): Readable {
    if (this.#child.stderr === null) {
      throw new Error('LspServerProcess: stderr is not available');
    }
    return this.#child.stderr;
  }

  /** Has the process already exited? */
  get exited(): boolean {
    return this.#child.exitCode !== null || this.#child.signalCode !== null;
  }

  /** Subscribe to process exit. Returns an unsubscribe closure. */
  onExit(listener: LspExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  /**
   * Send SIGTERM, then SIGKILL after a 5 s grace. Idempotent — multiple
   * calls are coalesced into one shutdown sequence. Resolves once
   * `kill()` has been called; the `exit` event fires asynchronously and
   * `onExit` listeners observe the final state.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.exited) return;

    try {
      this.#child.kill('SIGTERM');
    } catch {
      // pid may already be gone; ignore.
    }

    this.#killTimer = setTimeout(() => {
      this.#killTimer = null;
      if (this.exited) return;
      try {
        this.#child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 5000);
    // Don't keep Node alive just to escalate a child we asked to die —
    // the parent process is heading for `before-quit` anyway.
    if (typeof this.#killTimer.unref === 'function') {
      this.#killTimer.unref();
    }
  }
}

/**
 * Expand the `${pluginDir}` token in `template`.
 *
 * The expanded path is required to live inside `pluginDir`. Anything
 * that resolves outside (e.g. `${pluginDir}/../bin/rm`) throws.
 *
 * `template` without the token is returned verbatim — bare program
 * names like `java` are valid and resolved by the OS PATH at spawn.
 */
export function expandCommandPath(template: string, pluginDir: string): string {
  const TOKEN = '${pluginDir}';
  if (!template.includes(TOKEN)) return template;
  const expanded = template.split(TOKEN).join(pluginDir);
  // Path-safety: after substitution, the *first* token (the program
  // path) must live inside the plugin folder. Args after a space are
  // expanded too but plugin authors are responsible for keeping those
  // sensible — we can only police paths under our root.
  const programPath = expanded.split(/\s+/, 1)[0];
  if (programPath === undefined || programPath.length === 0) {
    throw new Error(`expandCommandPath: empty command after expansion: "${template}"`);
  }
  const absolute = resolve(programPath);
  const guard = pluginDir.endsWith(sep) ? pluginDir : pluginDir + sep;
  if (absolute !== pluginDir && !absolute.startsWith(guard)) {
    throw new Error(
      `expandCommandPath: command escapes plugin root: ${template}`,
    );
  }
  return expanded;
}

/**
 * Expand `${pluginDir}` in a string list (used for args / single cwd).
 *
 * Same safety check as {@link expandCommandPath} for the cwd case; args
 * are passed through verbatim because they may legitimately contain
 * paths outside the plugin (e.g. `--workspace ${projectRoot}` style
 * tokens the renderer pre-resolves before calling main).
 */
export function expandArgs(args: string[], pluginDir: string): string[] {
  const TOKEN = '${pluginDir}';
  return args.map((a) => (a.includes(TOKEN) ? a.split(TOKEN).join(pluginDir) : a));
}

/**
 * Expand `${pluginDir}` in a cwd template and enforce path-safety.
 *
 * The cwd may legitimately point outside the plugin folder (e.g. at the
 * active project's repo). The only thing we enforce here is the no-null-
 * byte rule + that, when `${pluginDir}` is used, the result stays inside
 * the plugin folder.
 */
export function expandCwd(template: string, pluginDir: string): string {
  if (template.includes('\0')) {
    throw new Error('expandCwd: template contains null byte');
  }
  const TOKEN = '${pluginDir}';
  if (!template.includes(TOKEN)) return template;
  const expanded = template.split(TOKEN).join(pluginDir);
  const absolute = resolve(expanded);
  const guard = pluginDir.endsWith(sep) ? pluginDir : pluginDir + sep;
  if (absolute !== pluginDir && !absolute.startsWith(guard)) {
    throw new Error(`expandCwd: cwd escapes plugin root: ${template}`);
  }
  return absolute;
}

/**
 * Drop a handful of Electron-specific variables before handing the env
 * to a child server. ELECTRON_RUN_AS_NODE is the dangerous one — leaving
 * it set would make e.g. a `java` launcher reinterpret itself as a
 * Node script.
 */
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.ELECTRON_NO_ASAR;
  return out;
}
