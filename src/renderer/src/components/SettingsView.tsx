/**
 * Settings editor view (E4-02).
 *
 * A searchable, grouped, typed settings editor driven entirely by
 * {@link SETTINGS_SCHEMA}. Each row renders the right input for the setting's
 * declared kind (toggle / number / text / list / select), shows a "modified"
 * dot when the user has overridden the default, and offers a per-row reset.
 *
 * The "Edit in settings.json" button is the escape hatch: it ensures the file
 * exists on disk (a no-op `update({})` writes it through the main store) then
 * opens it as a normal editor tab. Saving that tab round-trips back through the
 * store's file watcher, so the typed UI and the JSON stay consistent.
 *
 * Reads/writes go through the renderer settings store; persistence + merge live
 * in main (E4-01).
 */

import { useMemo, useState } from 'react'

import {
  SETTINGS_SCHEMA,
  DEFAULT_SETTINGS,
  settingsValueEqual,
  type SettingDescriptor,
  type SettingsCategory,
  type Settings,
} from '../../../types/settings'
import { useSettingsStore } from '../store/settingsStore'
import { Icon } from './primitives'

const CATEGORY_ORDER: ReadonlyArray<SettingsCategory> = [
  'Editor',
  'Files',
  'Search',
  'Workbench',
]

export interface SettingsViewProps {
  /** Open a file path as an editor tab (used by the JSON escape hatch). */
  onOpenFile: (path: string) => void
  /** Optional close affordance — when present a back button is shown. */
  onClose?: () => void
}

export function SettingsView({ onOpenFile, onClose }: SettingsViewProps) {
  const settings = useSettingsStore((s) => s.settings)
  const path = useSettingsStore((s) => s.path)
  const setSetting = useSettingsStore((s) => s.set)
  const [query, setQuery] = useState('')

  const filtered = useMemo<ReadonlyArray<SettingDescriptor>>(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return SETTINGS_SCHEMA
    return SETTINGS_SCHEMA.filter((d) =>
      (d.key + ' ' + d.title + ' ' + d.description)
        .toLowerCase()
        .includes(needle),
    )
  }, [query])

  const grouped = useMemo(() => {
    const byCat = new Map<SettingsCategory, SettingDescriptor[]>()
    for (const d of filtered) {
      const list = byCat.get(d.category) ?? []
      list.push(d)
      byCat.set(d.category, list)
    }
    return CATEGORY_ORDER.map((cat) => [cat, byCat.get(cat) ?? []] as const).filter(
      ([, list]) => list.length > 0,
    )
  }, [filtered])

  async function openJson(): Promise<void> {
    if (!window.hive?.settings) return
    // Ensure settings.json exists on disk before opening it.
    await window.hive.settings.update({})
    const p = path || (await window.hive.settings.get()).path
    if (p) onOpenFile(p)
  }

  return (
    <div className="wsview">
      <div className="ws-toolbar">
        {onClose && (
          <button
            type="button"
            className="set-jsonbtn"
            title="Close settings"
            onClick={onClose}
            aria-label="Close settings"
          >
            <Icon name="arrow-left" size={13} />
          </button>
        )}
        <div className="ws-title">
          <Icon name="settings" size={15} /> Settings
        </div>
        <div className="set-search">
          <Icon name="search" size={13} />
          <input
            value={query}
            placeholder="Search settings"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search settings"
          />
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="set-jsonbtn"
          onClick={() => void openJson()}
        >
          <Icon name="braces" size={13} /> Edit in settings.json
        </button>
      </div>

      <div className="set-body">
        {grouped.length === 0 && (
          <div className="set-empty">No settings match “{query}”.</div>
        )}
        {grouped.map(([cat, list]) => (
          <section key={cat} className="set-group">
            <h2 className="set-group-h">{cat}</h2>
            {list.map((d) => (
              <SettingRow
                key={d.key}
                descriptor={d}
                value={settings[d.key]}
                isDefault={settingsValueEqual(settings[d.key], DEFAULT_SETTINGS[d.key])}
                onChange={(v) => setSetting(d.key, v as Settings[typeof d.key])}
                onReset={() =>
                  setSetting(d.key, DEFAULT_SETTINGS[d.key] as Settings[typeof d.key])
                }
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

interface SettingRowProps {
  descriptor: SettingDescriptor
  value: unknown
  isDefault: boolean
  onChange: (value: unknown) => void
  onReset: () => void
}

function SettingRow({
  descriptor,
  value,
  isDefault,
  onChange,
  onReset,
}: SettingRowProps) {
  const { input, title, description, key } = descriptor
  return (
    <div className="set-row">
      <div className="set-row-head">
        {!isDefault && <span className="set-mod" title="Modified from default" />}
        <span className="set-row-title">{title}</span>
        <span className="set-row-key">{key}</span>
        {!isDefault && (
          <button
            type="button"
            className="set-reset"
            title="Reset to default"
            onClick={onReset}
          >
            <Icon name="rotate-ccw" size={12} />
          </button>
        )}
      </div>
      <div className="set-row-desc">{description}</div>
      <div className="set-row-input">
        {input.type === 'boolean' && (
          <label className="set-toggle">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span>{value ? 'On' : 'Off'}</span>
          </label>
        )}
        {input.type === 'number' && (
          <input
            type="number"
            className="set-num"
            value={Number(value)}
            min={input.min}
            max={input.max}
            step={input.step}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        )}
        {input.type === 'string' && (
          <input
            type="text"
            className="set-text"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {input.type === 'select' && (
          <select
            className="set-select"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          >
            {input.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )}
        {input.type === 'string[]' && (
          <textarea
            className="set-textarea"
            value={(Array.isArray(value) ? value : []).join('\n')}
            rows={Math.max(2, Array.isArray(value) ? value.length : 2)}
            placeholder="One entry per line"
            onChange={(e) =>
              onChange(
                e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              )
            }
          />
        )}
      </div>
    </div>
  )
}

export default SettingsView
