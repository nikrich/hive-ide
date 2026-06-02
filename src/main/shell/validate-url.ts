/**
 * URL scheme allowlist for `shell.openExternal` / `setWindowOpenHandler`
 * — REQ-002 / STORY-020.
 *
 * The renderer is untrusted, so anything we feed into the OS URL handler
 * has to be checked first. We only allow `http:` and `https:`.
 *
 * Why exactly two schemes:
 *   - `file:`        — would let the renderer ask the OS to open arbitrary
 *                      local files, sidestepping the `fs:*` validation in
 *                      `fs/validate-path.ts`.
 *   - `javascript:`  — some launchers honour it; would let a compromised
 *                      renderer trigger script execution in the user's
 *                      default browser.
 *   - `mailto:`, `vscode://`, `slack://`, `tel:`, custom app protocols —
 *                      all of these can be used to phish or to trigger
 *                      side-effects in other apps. If we later need any
 *                      of them, add them deliberately and document why.
 *
 * Kept as a separate module so both `shell/handlers.ts` (the IPC
 * boundary) and `main/index.ts` (the `setWindowOpenHandler` for in-page
 * window-open requests) share one implementation and one test surface.
 */

/**
 * Throw if `raw` is not an `http(s)` URL; otherwise return the normalised
 * URL string (the result of `new URL(raw).toString()` — strips fragments
 * the browser doesn't need, encodes non-ASCII consistently).
 */
export function assertHttpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`refusing to open URL: not a valid URL (${truncate(raw)})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `refusing to open URL: scheme ${parsed.protocol} not allowed (only http/https)`,
    );
  }
  return parsed.toString();
}

/**
 * Returns `true` when `raw` is an `http(s)` URL; never throws. Used by the
 * `setWindowOpenHandler` path where the contract is to return
 * `{ action: 'deny' }` rather than throw.
 */
export function isHttpUrl(raw: string): boolean {
  try {
    return assertHttpUrl(raw) !== '';
  } catch {
    return false;
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
