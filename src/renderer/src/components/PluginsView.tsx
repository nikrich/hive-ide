/**
 * Plugins workarea view — REQ-006.
 *
 * Surfaces the per-workspace plugins folder as a manageable list. From
 * here the operator can:
 *
 *   - install a new plugin from a local folder
 *   - install a new plugin from a GitHub release
 *   - enable / disable an installed plugin per project
 *   - uninstall an installed plugin (with confirm)
 *
 * The view is fully store-driven: the live `plugins` array comes from
 * the workspace store (seeded on boot by App.tsx after `plugins.list()`
 * resolves) and `enabledPlugins` is keyed by the active `Project.id`.
 *
 * Install / uninstall round-trip through `window.hive.plugins.*` and
 * then re-run `plugins.list()` so the store reflects on-disk truth — we
 * deliberately don't trust the optimistic single-record results we got
 * back, because a future story will let plugins ship multiple bundles
 * per release and we want one source of truth.
 */

import { useCallback, useEffect, useState } from 'react'

import type { LoadedPlugin } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { forgetPluginRegistrations } from '../lib/pluginMonaco'
import { Btn, Icon } from './primitives'

// ---------------------------------------------------------------------------
// Inline styles — `.view` / `.phead` / `.card` are styled by ide.css; the
// rest are local to this view (kept inline so a new file doesn't ship a
// matching CSS change in the same story).
// ---------------------------------------------------------------------------

const GRID: React.CSSProperties = {
  padding: '6px 32px 32px',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
  gap: 14,
}

const CARD: React.CSSProperties = {
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const CARD_HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
}

const ID_LINE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--fg-3)',
}

const DESC: React.CSSProperties = {
  font: 'var(--t-body-sm)',
  color: 'var(--fg-2)',
}

const META: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  font: 'var(--t-meta)',
  color: 'var(--fg-3)',
}

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 4,
}

const TOGGLE_LABEL: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  font: 'var(--t-body-sm)',
  color: 'var(--fg-1)',
}

const ERROR_BOX: React.CSSProperties = {
  background: 'var(--bg-base)',
  border: '1px solid var(--diff-del-fg)',
  borderRadius: 'var(--r-sm)',
  padding: '8px 10px',
  font: 'var(--t-meta)',
  color: 'var(--diff-del-fg)',
}

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

export function PluginsView({ plugins: pluginsProp }: PluginsViewProps) {
  const storePlugins = useWorkspaceStore((s) => s.plugins)
  const plugins = pluginsProp ?? storePlugins

  const project = useWorkspaceStore((s) => s.project)
  const isEnabled = useWorkspaceStore((s) => s.isPluginEnabled)
  const setEnabled = useWorkspaceStore((s) => s.setPluginEnabled)
  const setPlugins = useWorkspaceStore((s) => s.setPlugins)

  const [installOpen, setInstallOpen] = useState(false)
  const [installChoice, setInstallChoice] = useState<InstallChoice>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1>Plugins</h1>
            <div className="sub">
              Third-party language plugins installed for this workspace.
              Enable per project; disable to fall back to Monaco defaults.
            </div>
          </div>
          <Btn
            kind="amber"
            icon="package-plus"
            onClick={() => setInstallOpen((v) => !v)}
          >
            Install
          </Btn>
        </div>
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
        {project === null && (
          <div
            style={{
              margin: '12px 32px 0',
              padding: '8px 12px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-sm)',
              font: 'var(--t-meta)',
              color: 'var(--fg-3)',
            }}
          >
            Select a project to enable plugins. Toggles are read-only until
            a project is active.
          </div>
        )}
      </div>

      {error !== null && (
        <div style={{ padding: '0 32px 12px' }}>
          <div style={ERROR_BOX}>{error}</div>
        </div>
      )}

      {plugins.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={GRID}>
          {plugins.map((p) => (
            <PluginCard
              key={p.manifest.id}
              plugin={p}
              enabled={isEnabled(p.manifest.id)}
              busy={busy}
              canToggle={project !== null}
              onToggle={(next) => handleToggle(p, next)}
              onUninstall={() => void handleUninstall(p)}
            />
          ))}
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
// PluginCard
// ---------------------------------------------------------------------------

interface PluginCardProps {
  plugin: LoadedPlugin
  enabled: boolean
  busy: boolean
  canToggle: boolean
  onToggle: (next: boolean) => void
  onUninstall: () => void
}

function PluginCard({
  plugin,
  enabled,
  busy,
  canToggle,
  onToggle,
  onUninstall,
}: PluginCardProps) {
  const { manifest, valid, invalidReason } = plugin
  return (
    <div className="card" style={CARD}>
      <div style={CARD_HEAD}>
        <div>
          <div
            style={{
              font: '600 14.5px/1.35 var(--font-ui)',
              color: 'var(--fg-1)',
            }}
          >
            {manifest.name}
          </div>
          <div style={ID_LINE}>{manifest.id}</div>
        </div>
        <div style={META}>
          <span>v{manifest.version}</span>
          {manifest.publisher !== undefined && (
            <span>· {manifest.publisher}</span>
          )}
        </div>
      </div>

      {manifest.description !== undefined && (
        <div style={DESC}>{manifest.description}</div>
      )}

      {!valid && invalidReason !== undefined && (
        <div style={ERROR_BOX}>{invalidReason}</div>
      )}

      <div style={ROW}>
        <label style={TOGGLE_LABEL}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canToggle || !valid || busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
        <Btn kind="ghost" icon="trash-2" sm onClick={onUninstall}>
          Uninstall
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      style={{
        margin: '40px auto',
        maxWidth: 520,
        textAlign: 'center',
        font: 'var(--t-body-sm)',
        color: 'var(--fg-3)',
      }}
    >
      <Icon name="package" size={32} />
      <div style={{ marginTop: 12 }}>
        No plugins installed. Use <strong>Install</strong> to add one from a
        local folder or a GitHub release.
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
      <div className="menu menu-install">
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
