/**
 * Plugins workarea view — REQ-006, redesigned as a master–detail
 * "extensions" panel (design handoff: Hive IDE.html / plugins.jsx).
 *
 * The list (left) groups installed language plugins by the kind of
 * contribution they ship; the detail (right) shows the selected plugin's
 * overview, contributed languages, language servers, setup downloads, and
 * a metadata footer. From here the operator can:
 *
 *   - install a new plugin from a local folder
 *   - install a new plugin from a GitHub release
 *   - enable / disable an installed plugin per project (the detail toggle)
 *   - uninstall an installed plugin (with confirm)
 *
 * The view is fully store-driven: the live `plugins` array comes from the
 * workspace store (seeded on boot by App.tsx after `plugins.list()`
 * resolves) and `enabledPlugins` is keyed by the active `Project.id`.
 *
 * The visual chrome (`wsview` / `ws-toolbar` / `seg` / `plug-*`) lives in
 * `styles/ide.css` and is shared with the other workspace views. The
 * design's fictional marketplace fields (ratings, install counts,
 * per-agent-role capabilities) have no backing data, so the panel is
 * populated entirely from the real plugin manifest instead.
 *
 * Install / uninstall round-trip through `window.hive.plugins.*` and then
 * re-run `plugins.list()` so the store reflects on-disk truth — we
 * deliberately don't trust the optimistic single-record results we got
 * back, because a future story will let plugins ship multiple bundles per
 * release and we want one source of truth.
 */

import { useCallback, useState } from 'react'

import type { LoadedPlugin } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { forgetPluginRegistrations } from '../lib/pluginMonaco'
import { useSettingsStore } from '../store/settingsStore'
import { MarketplacePanel } from './MarketplacePanel'
import { Btn, Icon, Pulse, hexA } from './primitives'

// ---------------------------------------------------------------------------
// Derivations — real manifest fields → the design's master–detail shape.
// ---------------------------------------------------------------------------

/** Per-project lifecycle state of a plugin, used for dots/segments/footer. */
type PluginState = 'enabled' | 'disabled' | 'invalid'

interface StateMeta {
  label: string
  /** Maps to `.plug-rowdot.<cls>` / `.plug-state.<cls>` in ide.css. */
  cls: 'on' | 'off' | 'err'
}

const STATE_META: Record<PluginState, StateMeta> = {
  enabled: { label: 'Enabled', cls: 'on' },
  disabled: { label: 'Disabled', cls: 'off' },
  invalid: { label: 'Invalid', cls: 'err' },
}

/**
 * Category buckets, ordered. Plugins land in the richest bucket their
 * manifest qualifies for — a server-shipping plugin sits under "Language
 * servers" even if it also contributes a grammar.
 */
const CAT_ORDER = ['Language servers', 'Languages', 'Other'] as const

function categoryOf(p: LoadedPlugin): (typeof CAT_ORDER)[number] {
  const c = p.manifest.contributes
  if (c?.languageServers !== undefined && c.languageServers.length > 0) {
    return 'Language servers'
  }
  if (c?.languages !== undefined && c.languages.length > 0) return 'Languages'
  return 'Other'
}

function stateOf(p: LoadedPlugin, enabled: boolean): PluginState {
  if (!p.valid) return 'invalid'
  return enabled ? 'enabled' : 'disabled'
}

/**
 * Stable per-plugin accent, hashed from the id so a plugin always gets the
 * same coloured icon tile. Mirrors the design's per-plugin `color` field.
 */
const TILE_PALETTE = [
  '#8B5CF6',
  '#6366F1',
  '#14B8A6',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#22D3EE',
  '#EF4444',
]

function tileColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return TILE_PALETTE[h % TILE_PALETTE.length]
}

const SEP = <span className="sep">·</span>

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PluginsViewProps {
  /**
   * Optional projection: pass-through so the caller can render the view
   * with a custom snapshot (mostly for tests / future preview pane).
   * When omitted the view reads from the workspace store.
   */
  plugins?: LoadedPlugin[]
}

type InstallChoice = null | 'github'
type Filter = 'all' | 'enabled' | 'disabled' | 'invalid'

export function PluginsView({ plugins: pluginsProp }: PluginsViewProps) {
  const storePlugins = useWorkspaceStore((s) => s.plugins)
  const plugins = pluginsProp ?? storePlugins

  const project = useWorkspaceStore((s) => s.project)
  // Subscribe to the per-project enabled map (and project id) DIRECTLY so the
  // detail toggle re-renders when enable state changes. Reading the
  // `isPluginEnabled` *selector function* instead would never re-render on a
  // toggle (the function identity is stable).
  const enabledMap = useWorkspaceStore((s) => s.enabledPlugins)
  const projectId = project?.id ?? null
  const isEnabled = (pluginId: string): boolean =>
    projectId !== null && (enabledMap[projectId]?.includes(pluginId) ?? false)
  const setEnabled = useWorkspaceStore((s) => s.setPluginEnabled)
  const setPlugins = useWorkspaceStore((s) => s.setPlugins)

  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [installChoice, setInstallChoice] = useState<InstallChoice>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const registryUrl = useSettingsStore((s) => s.settings['extensions.registryUrl'])

  // ----- refresh helpers ------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const next = await window.hive.plugins.list()
      setPlugins(next)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('plugins.list failed', err)
    }
  }, [setPlugins])

  // ----- install: local folder -----------------------------------------
  const handleInstallLocal = useCallback(async () => {
    setError(null)
    setInstallOpen(false)
    setBusy(true)
    try {
      const picked = await window.hive.project.openDialog()
      if (picked.canceled || !picked.path) return
      await window.hive.plugins.installLocal(picked.path)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  // ----- uninstall ------------------------------------------------------
  const handleUninstall = useCallback(
    async (plugin: LoadedPlugin) => {
      const ok = window.confirm(`Uninstall ${plugin.manifest.name}?`)
      if (!ok) return
      setBusy(true)
      setError(null)
      try {
        await window.hive.plugins.uninstall(plugin.manifest.id)
        forgetPluginRegistrations(plugin.manifest.id)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Uninstall failed')
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  // ----- enable toggle --------------------------------------------------
  const handleToggle = useCallback(
    (plugin: LoadedPlugin, next: boolean) => {
      setEnabled(plugin.manifest.id, next)
      if (!next) {
        // Drop Monaco bookkeeping so re-enable re-reads grammar from disk.
        forgetPluginRegistrations(plugin.manifest.id)
      }
    },
    [setEnabled],
  )

  // ----- filter / search / group ----------------------------------------
  const decorated = plugins.map((p) => ({
    p,
    enabled: isEnabled(p.manifest.id),
    state: stateOf(p, isEnabled(p.manifest.id)),
  }))

  const counts = {
    all: decorated.length,
    enabled: decorated.filter((d) => d.state === 'enabled').length,
    disabled: decorated.filter((d) => d.state === 'disabled').length,
    invalid: decorated.filter((d) => d.state === 'invalid').length,
  }

  const ql = q.trim().toLowerCase()
  const rows = decorated.filter((d) => {
    if (filter === 'enabled' && d.state !== 'enabled') return false
    if (filter === 'disabled' && d.state !== 'disabled') return false
    if (filter === 'invalid' && d.state !== 'invalid') return false
    if (ql === '') return true
    const m = d.p.manifest
    const hay = `${m.name} ${m.id} ${m.publisher ?? ''} ${m.description ?? ''} ${categoryOf(d.p)}`
    return hay.toLowerCase().includes(ql)
  })

  // group rows by derived category, in CAT_ORDER then any stragglers
  const byCat = new Map<string, typeof rows>()
  for (const r of rows) {
    const cat = categoryOf(r.p)
    const bucket = byCat.get(cat)
    if (bucket) bucket.push(r)
    else byCat.set(cat, [r])
  }
  // `categoryOf` only ever returns a CAT_ORDER member, so this both orders
  // and filters to the non-empty buckets.
  const order = CAT_ORDER.filter((c) => byCat.has(c))

  const sel = rows.find((r) => r.p.manifest.id === selId) ?? rows[0] ?? null

  const segs: { k: Filter; label: string }[] = [
    { k: 'all', label: 'All' },
    { k: 'enabled', label: 'Enabled' },
    { k: 'disabled', label: 'Disabled' },
  ]
  if (counts.invalid > 0) segs.push({ k: 'invalid', label: 'Invalid' })

  return (
    <div className="wsview">
      <div className="ws-tabbar">
        <div className="ws-tab">
          <Icon name="blocks" size={14} /> Plugins
        </div>
      </div>

      <div className="ws-toolbar">
        <div className="seg">
          {segs.map((s) => (
            <button
              key={s.k}
              className={filter === s.k ? 'on' : ''}
              onClick={() => setFilter(s.k)}
            >
              {s.label} <span className="sc">{counts[s.k]}</span>
            </button>
          ))}
        </div>
        <div className="ws-tb-right">
          <span className="ws-live">
            <Pulse /> {counts.enabled} enabled
          </span>
          <Btn
            sm
            icon="store"
            kind={marketplaceOpen ? 'amber' : 'ghost'}
            onClick={() => setMarketplaceOpen((v) => !v)}
          >
            Marketplace
          </Btn>
          <div className="ws-find">
            <Icon name="search" size={14} />
            <input
              value={q}
              placeholder="Search plugins…"
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <Btn
              kind="amber"
              sm
              icon="package-plus"
              onClick={() => setInstallOpen((v) => !v)}
            >
              Install
            </Btn>
            {installOpen && (
              <InstallMenu
                onLocal={() => void handleInstallLocal()}
                onGithub={() => {
                  setInstallOpen(false)
                  setInstallChoice('github')
                }}
                onClose={() => setInstallOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {project === null && (
        <div className="plug-note">
          <Icon name="info" size={15} />
          Select a project to enable plugins. Toggles are read-only until a
          project is active.
        </div>
      )}

      {error !== null && (
        <div className="plug-note err">
          <Icon name="alert-triangle" size={15} />
          {error}
        </div>
      )}

      {marketplaceOpen ? (
        <MarketplacePanel
          installed={plugins}
          registryUrl={registryUrl}
          onInstalled={refresh}
        />
      ) : (
      <div className="plug-body">
        <div className="plug-list">
          {order.map((cat) => {
            const bucket = byCat.get(cat)
            if (!bucket) return null
            return (
              <div className="plug-grp" key={cat}>
                <div className="plug-grp-h">
                  {cat} <span>{bucket.length}</span>
                </div>
                {bucket.map(({ p, state }) => (
                  <PluginRow
                    key={p.manifest.id}
                    plugin={p}
                    state={state}
                    active={sel?.p.manifest.id === p.manifest.id}
                    onClick={() => setSelId(p.manifest.id)}
                  />
                ))}
              </div>
            )
          })}
          {rows.length === 0 && (
            <div className="ws-empty">
              {plugins.length === 0
                ? 'No plugins installed. Use Install to add one from a local folder or a GitHub release.'
                : 'No plugins match this filter.'}
            </div>
          )}
        </div>

        {sel ? (
          <PluginDetail
            plugin={sel.p}
            state={sel.state}
            enabled={sel.enabled}
            canToggle={project !== null}
            busy={busy}
            onToggle={(next) => handleToggle(sel.p, next)}
            onUninstall={() => void handleUninstall(sel.p)}
          />
        ) : (
          <div className="plug-detail empty">
            <div className="ws-empty">Select a plugin to see details.</div>
          </div>
        )}
      </div>
      )}

      {installChoice === 'github' && (
        <GithubInstallModal
          onClose={() => setInstallChoice(null)}
          onInstalled={async () => {
            setInstallChoice(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plugin icon tile
// ---------------------------------------------------------------------------

function PluginIcon({ id, size }: { id: string; size: number }) {
  const color = tileColor(id)
  return (
    <span
      className="plug-ic"
      style={{
        width: size,
        height: size,
        color,
        background: hexA(color, 0.14),
        borderColor: hexA(color, 0.34),
      }}
    >
      <Icon name="blocks" size={Math.round(size * 0.5)} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// PluginRow (list)
// ---------------------------------------------------------------------------

interface PluginRowProps {
  plugin: LoadedPlugin
  state: PluginState
  active: boolean
  onClick: () => void
}

function PluginRow({ plugin, state, active, onClick }: PluginRowProps) {
  const { manifest } = plugin
  const sm = STATE_META[state]
  const langCount = manifest.contributes?.languages?.length ?? 0
  return (
    <div className={'plug-row' + (active ? ' sel' : '')} onClick={onClick}>
      <PluginIcon id={manifest.id} size={34} />
      <div className="plug-row-main">
        <div className="plug-row-top">
          <span className="nm">{manifest.name}</span>
          {state === 'invalid' && <span className="plug-core warn">Invalid</span>}
        </div>
        <div className="plug-row-blurb">{manifest.description ?? manifest.id}</div>
        <div className="plug-row-meta">
          <span>{manifest.publisher ?? '—'}</span>
          {SEP}
          <span className="mono">v{manifest.version}</span>
          {langCount > 0 && (
            <>
              {SEP}
              <span>
                <Icon name="code" size={11} /> {langCount} lang
                {langCount > 1 ? 's' : ''}
              </span>
            </>
          )}
        </div>
      </div>
      <span className={'plug-rowdot ' + sm.cls} title={sm.label}>
        {state === 'enabled' ? <Pulse /> : <span className="sd" />}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PluginDetail
// ---------------------------------------------------------------------------

interface PluginDetailProps {
  plugin: LoadedPlugin
  state: PluginState
  enabled: boolean
  canToggle: boolean
  busy: boolean
  onToggle: (next: boolean) => void
  onUninstall: () => void
}

function PluginDetail({
  plugin,
  state,
  enabled,
  canToggle,
  busy,
  onToggle,
  onUninstall,
}: PluginDetailProps) {
  const { manifest: m, rootPath } = plugin
  const sm = STATE_META[state]
  const langs = m.contributes?.languages ?? []
  const servers = m.contributes?.languageServers ?? []
  const downloads = m.setup?.downloads ?? []

  return (
    <div className="plug-detail">
      <div className="plug-d-head">
        <PluginIcon id={m.id} size={56} />
        <div className="plug-d-id">
          <div className="plug-d-name">
            {m.name}
            {state === 'invalid' && <span className="plug-core warn">Invalid</span>}
          </div>
          <div className="plug-d-sub">
            <span>{m.publisher ?? '—'}</span>
            {SEP}
            <span className="mono">v{m.version}</span>
            {m.engines?.hive !== undefined && (
              <>
                {SEP}
                <span className="mono">hive {m.engines.hive}</span>
              </>
            )}
            {langs.length > 0 && (
              <>
                {SEP}
                <span>
                  <Icon name="code" size={12} /> {langs.length} language
                  {langs.length > 1 ? 's' : ''}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="plug-d-actions">
          <button
            type="button"
            className={'plug-switch' + (enabled ? ' on' : '')}
            onClick={() => onToggle(!enabled)}
            disabled={!canToggle || !plugin.valid || busy}
            title={
              !plugin.valid
                ? 'Plugin is invalid'
                : !canToggle
                  ? 'Select a project first'
                  : enabled
                    ? 'Disable'
                    : 'Enable'
            }
          >
            <span className="knob" />
          </button>
          <Btn kind="ghost" sm icon="trash-2" onClick={onUninstall} disabled={busy}>
            Uninstall
          </Btn>
        </div>
      </div>

      {state === 'invalid' && plugin.invalidReason !== undefined && (
        <div className="plug-note err">
          <Icon name="alert-triangle" size={15} /> {plugin.invalidReason}
        </div>
      )}

      <div className="plug-scroll">
        <section className="plug-sec">
          <h4>Overview</h4>
          <p className="plug-long">
            {m.description ?? 'This plugin ships no description.'}
          </p>
        </section>

        {langs.length > 0 && (
          <section className="plug-sec">
            <h4>Languages</h4>
            <div className="plug-caps">
              {langs.map((l, i) => {
                const bits: string[] = []
                if (l.extensions && l.extensions.length > 0) {
                  bits.push(l.extensions.join(' '))
                }
                if (l.grammar !== undefined) bits.push('syntax highlighting')
                if (l.configuration !== undefined) bits.push('language config')
                return (
                  <div className="plug-cap" key={i}>
                    <span className="plug-cap-role mono">{l.id}</span>
                    <span className="plug-cap-arrow">
                      <Icon name="arrow-right" size={13} />
                    </span>
                    <span className="plug-cap-txt">
                      {bits.length > 0 ? bits.join(' · ') : 'registered'}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {servers.length > 0 && (
          <section className="plug-sec">
            <h4>Language servers</h4>
            <div className="plug-perms">
              {servers.map((s, i) => (
                <div className="plug-perm" key={i}>
                  <span className="plug-perm-ic">
                    <Icon name="square-terminal" size={15} />
                  </span>
                  <span className="plug-perm-txt">
                    <span className="mono">{s.language}</span>
                    {' — '}
                    {`${s.command} ${(s.args ?? []).join(' ')}`.trim()}{' '}
                    <span className="dim">({s.transport ?? 'stdio'})</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {downloads.length > 0 && (
          <section className="plug-sec">
            <h4>Setup downloads</h4>
            <div className="plug-perms">
              {downloads.map((d, i) => (
                <div className="plug-perm" key={i}>
                  <span className="plug-perm-ic">
                    <Icon name="download" size={15} />
                  </span>
                  <span className="plug-perm-txt">
                    {d.url} <span className="dim">→ {d.extractTo}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="plug-sec plug-foot-sec">
          <div className="plug-kv">
            <span>Identifier</span>
            <span className="mono" title={m.id}>
              {m.id}
            </span>
          </div>
          <div className="plug-kv">
            <span>Version</span>
            <span className="mono">{m.version}</span>
          </div>
          <div className="plug-kv">
            <span>Publisher</span>
            <span>{m.publisher ?? '—'}</span>
          </div>
          <div className="plug-kv">
            <span>Category</span>
            <span>{categoryOf(plugin)}</span>
          </div>
          <div className="plug-kv">
            <span>Status</span>
            <span className={'plug-state inline ' + sm.cls}>
              {state === 'enabled' ? <Pulse /> : <span className="sd" />}
              {sm.label}
            </span>
          </div>
          <div className="plug-kv">
            <span>Install path</span>
            <span className="mono" title={rootPath}>
              {rootPath}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Install menu (anchored dropdown)
// ---------------------------------------------------------------------------

interface InstallMenuProps {
  onLocal: () => void
  onGithub: () => void
  onClose: () => void
}

function InstallMenu({ onLocal, onGithub, onClose }: InstallMenuProps) {
  return (
    <>
      <div
        // Invisible scrim — closes the menu on any outside click.
        style={{ position: 'fixed', inset: 0, zIndex: 70 }}
        onClick={onClose}
      />
      <div
        className="menu menu-install"
        style={{ top: 'calc(100% + 8px)', left: 'auto', right: 0, width: 300 }}
      >
        <div className="menu-head">Install plugin</div>
        <button type="button" className="menu-item menu-item-cta" onClick={onLocal}>
          <Icon name="folder-open" size={15} />
          <div className="mi-meta">
            <div className="mi-n">From folder…</div>
            <div className="mi-s">Pick a folder containing plugin.json</div>
          </div>
        </button>
        <button type="button" className="menu-item menu-item-cta" onClick={onGithub}>
          <Icon name="github" size={15} />
          <div className="mi-meta">
            <div className="mi-n">From GitHub release…</div>
            <div className="mi-s">Owner + repo + optional tag</div>
          </div>
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// GitHub install modal
// ---------------------------------------------------------------------------

interface GithubInstallModalProps {
  onClose: () => void
  onInstalled: () => Promise<void> | void
}

function GithubInstallModal({ onClose, onInstalled }: GithubInstallModalProps) {
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = owner.trim() !== '' && repo.trim() !== '' && !busy

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await window.hive.plugins.installGithub({
        owner: owner.trim(),
        repo: repo.trim(),
        tag: tag.trim() === '' ? undefined : tag.trim(),
      })
      await onInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
      setBusy(false)
    }
  }, [canSubmit, onInstalled, owner, repo, tag])

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gh-install-title"
        style={{ maxWidth: 480 }}
      >
        <div className="np-head">
          <h2 id="gh-install-title" className="np-title">
            Install from GitHub
          </h2>
          <button
            type="button"
            className="np-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="np-body">
          <label className="np-field">
            <span className="np-label">Owner</span>
            <input
              type="text"
              className="np-input"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="e.g. hive-ide"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="np-field">
            <span className="np-label">Repository</span>
            <input
              type="text"
              className="np-input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="e.g. plugin-rust"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="np-field">
            <span className="np-label">Tag (optional)</span>
            <input
              type="text"
              className="np-input"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="latest"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          {error !== null && <div className="np-error">{error}</div>}
        </div>

        <div className="np-foot">
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="amber"
            icon="download"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            Install
          </Btn>
        </div>
      </div>
    </div>
  )
}

export default PluginsView
