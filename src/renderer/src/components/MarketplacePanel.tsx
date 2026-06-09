/**
 * Plugin marketplace panel (E10-01, E10-02).
 *
 * Fetches the configured registry index, lets the operator search it, shows
 * each plugin's name/description/version, and installs by reusing the existing
 * GitHub-release install path. Already-installed plugins show "Installed" or,
 * when the registry advertises a newer version, an "Update" action (E10-02).
 *
 * Registry source + this approach are captured in
 * `docs/specs/2026-06-08-extension-marketplace-design.md`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { Btn, Icon } from './primitives'
import type { LoadedPlugin } from '../../../types/workspace'
import type { RegistryPlugin } from '../../../preload/api'

/** Loose semver-ish "is b newer than a" without a dependency. */
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (y > x) return true
    if (y < x) return false
  }
  return false
}

export interface MarketplacePanelProps {
  installed: LoadedPlugin[]
  registryUrl: string
  onInstalled: () => Promise<void> | void
}

export function MarketplacePanel({
  installed,
  registryUrl,
  onInstalled,
}: MarketplacePanelProps) {
  const [entries, setEntries] = useState<RegistryPlugin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const installedById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of installed) m.set(p.manifest.id, p.manifest.version)
    return m
  }, [installed])

  const load = useCallback(() => {
    if (registryUrl.trim() === '') {
      setError('No registry URL configured (extensions.registryUrl).')
      setEntries([])
      return
    }
    setLoading(true)
    setError(null)
    void window.hive.plugins
      .registryFetch(registryUrl)
      .then(setEntries)
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        setEntries([])
      })
      .finally(() => setLoading(false))
  }, [registryUrl])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = entries ?? []
    if (!needle) return list
    return list.filter((e) =>
      (e.id + ' ' + e.name + ' ' + (e.description ?? '')).toLowerCase().includes(needle),
    )
  }, [entries, q])

  const install = useCallback(
    async (e: RegistryPlugin) => {
      setBusyId(e.id)
      try {
        await window.hive.plugins.installGithub({
          owner: e.repo.owner,
          repo: e.repo.repo,
          tag: e.repo.tag,
        })
        await onInstalled()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [onInstalled],
  )

  return (
    <div className="mkt">
      <div className="mkt-bar">
        <div className="ws-find">
          <Icon name="search" size={14} />
          <input
            value={q}
            placeholder="Search marketplace…"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Btn sm kind="ghost" icon="refresh-cw" onClick={load}>
          Refresh
        </Btn>
      </div>

      {error && (
        <div className="plug-note err">
          <Icon name="alert-triangle" size={15} /> {error}
        </div>
      )}
      {loading && <div className="mkt-status">Loading registry…</div>}
      {!loading && entries !== null && filtered.length === 0 && !error && (
        <div className="mkt-status">No plugins found.</div>
      )}

      <div className="mkt-list">
        {filtered.map((e) => {
          const installedVer = installedById.get(e.id)
          const canUpdate = installedVer !== undefined && isNewer(installedVer, e.latest)
          return (
            <div key={e.id} className="mkt-card">
              <div className="mkt-card-main">
                <div className="mkt-card-title">
                  {e.name}
                  <span className="mkt-ver">v{e.latest}</span>
                  {e.publisher && <span className="mkt-pub">{e.publisher}</span>}
                </div>
                <div className="mkt-card-desc">{e.description ?? e.id}</div>
              </div>
              <div className="mkt-card-action">
                {installedVer === undefined ? (
                  <Btn
                    sm
                    kind="amber"
                    icon="download"
                    onClick={() => void install(e)}
                  >
                    {busyId === e.id ? 'Installing…' : 'Install'}
                  </Btn>
                ) : canUpdate ? (
                  <Btn sm kind="outline" icon="arrow-up" onClick={() => void install(e)}>
                    {busyId === e.id ? 'Updating…' : 'Update'}
                  </Btn>
                ) : (
                  <span className="mkt-installed">
                    <Icon name="check" size={13} /> Installed
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default MarketplacePanel
