/**
 * `launch.json` debug-configuration schema (E3-02).
 *
 * A subset of VSCode's launch schema sufficient to describe and pick run/debug
 * configurations. Adapter-specific fields are kept open via an index signature
 * so a given debug type (node, python, …) can carry its own options.
 */

export interface DebugConfiguration {
  /** Debug adapter type, e.g. `node`. */
  type: string
  /** `launch` (start a program) or `attach` (connect to a running one). */
  request: 'launch' | 'attach'
  /** Display name shown in the config picker. */
  name: string
  /** Program entry point (launch). */
  program?: string
  /** Program arguments. */
  args?: string[]
  /** Working directory. */
  cwd?: string
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Attach port (attach). */
  port?: number
  /** Adapter-specific extras. */
  [key: string]: unknown
}

export interface LaunchConfig {
  version: string
  configurations: DebugConfiguration[]
}

/** An empty launch config (no configurations). */
export const EMPTY_LAUNCH: LaunchConfig = { version: '0.2.0', configurations: [] }
