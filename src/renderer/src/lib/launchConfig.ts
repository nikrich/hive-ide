/**
 * launch.json loading + parsing (E3-02).
 *
 * `launch.json` is JSONC (allows `//` and block comments + trailing commas), so
 * a plain `JSON.parse` rejects real-world files. `stripJsonComments` + a
 * trailing-comma pass make it parseable; `parseLaunchConfig` validates the
 * result into a {@link LaunchConfig}. `loadLaunchConfig` reads the file from a
 * repo (`.vscode/launch.json`, falling back to `.hive/launch.json`).
 */

import {
  EMPTY_LAUNCH,
  type DebugConfiguration,
  type LaunchConfig,
} from '../../../types/launch'

/** Remove `//` line comments and `/* *​/` block comments outside strings. */
export function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let stringQuote = ''
  let inLine = false
  let inBlock = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const next = input[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === stringQuote) {
        inString = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      stringQuote = c
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

/** Drop trailing commas before `}` or `]`. */
function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, '$1')
}

/** Parse JSONC `launch.json` text into a validated {@link LaunchConfig}. */
export function parseLaunchConfig(text: string): LaunchConfig {
  const cleaned = stripTrailingCommas(stripJsonComments(text))
  const trimmed = cleaned.trim()
  if (trimmed === '') return EMPTY_LAUNCH
  const raw: unknown = JSON.parse(trimmed)
  if (typeof raw !== 'object' || raw === null) return EMPTY_LAUNCH
  const obj = raw as Record<string, unknown>
  const version = typeof obj.version === 'string' ? obj.version : '0.2.0'
  const configsRaw = Array.isArray(obj.configurations) ? obj.configurations : []
  const configurations: DebugConfiguration[] = []
  for (const c of configsRaw) {
    if (typeof c !== 'object' || c === null) continue
    const cfg = c as Record<string, unknown>
    if (typeof cfg.type !== 'string' || typeof cfg.name !== 'string') continue
    const request = cfg.request === 'attach' ? 'attach' : 'launch'
    configurations.push({ ...cfg, type: cfg.type, name: cfg.name, request })
  }
  return { version, configurations }
}

/**
 * Load + parse a repo's launch configurations. Tries `.vscode/launch.json`
 * then `.hive/launch.json`. Returns an empty config when neither exists.
 */
export async function loadLaunchConfig(repoPath: string): Promise<LaunchConfig> {
  const bridge = window.hive?.fs
  if (!bridge) return EMPTY_LAUNCH
  const sep = repoPath.includes('\\') ? '\\' : '/'
  const candidates = [
    `${repoPath}${sep}.vscode${sep}launch.json`,
    `${repoPath}${sep}.hive${sep}launch.json`,
  ]
  for (const file of candidates) {
    try {
      const { contents } = await bridge.readFile(file)
      return parseLaunchConfig(contents)
    } catch {
      // try next candidate
    }
  }
  return EMPTY_LAUNCH
}
