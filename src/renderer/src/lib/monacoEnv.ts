/**
 * Global Monaco namespace handle (E2-07).
 *
 * A few features (workspace-symbol search) need the Monaco namespace outside a
 * mounted editor. MonacoEditor captures it on `beforeMount`; consumers read it
 * here. Null until the first editor loads.
 */

import type * as Monaco from 'monaco-editor'

let monaco: typeof Monaco | null = null

export function setMonacoEnv(m: typeof Monaco): void {
  monaco = m
}

export function getMonacoEnv(): typeof Monaco | null {
  return monaco
}
