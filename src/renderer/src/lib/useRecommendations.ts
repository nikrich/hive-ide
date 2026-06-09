/**
 * Workspace extension recommendations (E10-10).
 *
 * Reads `.hive/extensions.json` (`{ "recommendations": ["id", …] }`) from the
 * project's first repo and, when any recommended plugin isn't installed, posts
 * a one-time notification with a button to open the marketplace. Mirrors
 * VSCode's `.vscode/extensions.json` recommendations.
 */

import { useEffect, useRef } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'
import { notify } from '../store/notificationsStore'

export function useRecommendations(onBrowse: () => void): void {
  const repos = useWorkspaceStore((s) => s.repos)
  const plugins = useWorkspaceStore((s) => s.plugins)
  const projectId = useWorkspaceStore((s) => s.project?.id ?? null)
  const notified = useRef<Set<string>>(new Set())

  useEffect(() => {
    const repo = repos[0]
    if (!repo || projectId === null || notified.current.has(projectId)) return
    const bridge = window.hive?.fs
    if (!bridge) return
    const sep = repo.path.includes('\\') ? '\\' : '/'
    const file = `${repo.path}${sep}.hive${sep}extensions.json`
    let cancelled = false
    void bridge
      .readFile(file)
      .then(({ contents }) => {
        if (cancelled) return
        const parsed = JSON.parse(contents) as { recommendations?: unknown }
        const rec = Array.isArray(parsed.recommendations)
          ? parsed.recommendations.filter((r): r is string => typeof r === 'string')
          : []
        const installed = new Set(plugins.map((p) => p.manifest.id))
        const missing = rec.filter((id) => !installed.has(id))
        if (missing.length > 0) {
          notified.current.add(projectId)
          notify(
            'info',
            `This workspace recommends extensions: ${missing.join(', ')}`,
            [{ label: 'Browse', run: onBrowse }],
          )
        }
      })
      .catch(() => undefined) // no recommendations file — fine
    return () => {
      cancelled = true
    }
  }, [repos, plugins, projectId, onBrowse])
}
