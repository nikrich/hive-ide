/**
 * Plugin contribution wiring (E10-04).
 *
 * Collects the keybindings contributed by the plugins enabled for the active
 * project and loads them into the keybinding registry's `contributed` layer
 * (which overrides defaults but yields to user bindings). Re-runs whenever the
 * enabled set or the plugin list changes.
 *
 * Chords are normalized to the registry's canonical form; the `mac` field is
 * preferred on macOS. A contributed binding to a command that isn't registered
 * stays inert (the global dispatcher skips unknown commands), so a plugin can
 * ship bindings ahead of an extension host that would provide the command.
 */

import { useEffect, useMemo } from 'react'

import { normalizeChord } from './keys'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useKeybindingStore, type Keybinding } from '../store/keybindingStore'
import { useSettingsStore, type PluginSettingEntry } from '../store/settingsStore'
import { registerTheme } from './themes'

export function usePluginContributions(): void {
  const plugins = useWorkspaceStore((s) => s.plugins)
  const projectId = useWorkspaceStore((s) => s.project?.id ?? null)
  const enabledMap = useWorkspaceStore((s) => s.enabledPlugins)
  const setContributed = useKeybindingStore((s) => s.setContributed)
  const setPluginConfig = useSettingsStore((s) => s.setPluginConfig)

  const enabledIds = useMemo<readonly string[]>(
    () => (projectId ? (enabledMap[projectId] ?? []) : []),
    [projectId, enabledMap],
  )

  useEffect(() => {
    const isMac = (window.hive?.platform ?? 'darwin') === 'darwin'
    const bindings: Keybinding[] = []
    const schema: PluginSettingEntry[] = []
    const defaults: Record<string, unknown> = {}
    for (const id of enabledIds) {
      const plugin = plugins.find((p) => p.manifest.id === id)
      if (plugin === undefined || !plugin.valid) continue
      // Keybindings (E10-04).
      for (const kb of plugin.manifest.contributes?.keybindings ?? []) {
        const raw = isMac && kb.mac ? kb.mac : kb.key
        bindings.push({
          key: normalizeChord(raw, isMac),
          command: kb.command,
          when: kb.when,
          source: 'contributed',
        })
      }
      // Configuration (E10-05).
      const config = plugin.manifest.contributes?.configuration
      if (config) {
        for (const [key, property] of Object.entries(config.properties)) {
          schema.push({ key, pluginId: id, property })
          defaults[key] = property.default
        }
      }
      // Themes (E10-07 / E8-04).
      for (const theme of plugin.manifest.contributes?.themes ?? []) {
        const base =
          theme.type === 'light' ? 'vs' : theme.type === 'hc' ? 'hc-black' : 'vs-dark'
        registerTheme({
          id: theme.id,
          label: theme.label,
          type: theme.type,
          monaco: { base, inherit: true, rules: [], colors: theme.colors ?? {} },
        })
      }
    }
    setContributed(bindings)
    setPluginConfig(schema, defaults)
  }, [enabledIds, plugins, setContributed, setPluginConfig])
}
