/**
 * Workbench chrome commands (E6-01, E6-06).
 *
 * Registers the App-shell commands — open the palette, toggle the panel, open
 * settings, switch views — into the command registry, and loads the default
 * keybindings into the keybinding registry. These commands close over App's
 * state setters, so they're registered from a hook mounted inside App rather
 * than at module scope.
 *
 * Migrating these off the ad-hoc `window.addEventListener('keydown', …)` blocks
 * is the first slice of E6-06 (migrate existing actions onto the registry).
 */

import { useEffect } from 'react'

import { DEFAULT_KEYBINDINGS } from './defaultBindings'
import { useCommandStore, type Command } from '../store/commandStore'
import { useKeybindingStore } from '../store/keybindingStore'
import { loadUserKeybindings } from './keybindingsPersistence'
import { useSettingsStore } from '../store/settingsStore'
import { useDebugStore } from '../store/debugStore'
import { allThemes } from './themes'

export interface ChromeCommandActions {
  /** Open the command palette, optionally pre-filling the query. */
  openPalette: (initialQuery?: string) => void
  /** Toggle the bottom panel open/closed. */
  togglePanel: () => void
  /** Open the settings editor. */
  openSettings: () => void
  /** Open the global search view. */
  openSearch: () => void
  /** Open the Run & Debug view. */
  openDebug: () => void
  /** Toggle zen mode. */
  toggleZen: () => void
  /** Open the keyboard-shortcuts editor. */
  openKeybindings: () => void
  /** Open the New Project modal. */
  newProject: () => void
  /** Open the bottom panel on the Problems tab. */
  showProblems: () => void
  /** Navigate the workarea (mirrors App's `nav`). */
  nav: (target: string) => void
}

export function useChromeCommands(actions: ChromeCommandActions): void {
  const register = useCommandStore((s) => s.register)
  const setDefaults = useKeybindingStore((s) => s.setDefaults)
  const setUser = useKeybindingStore((s) => s.setUser)

  // Load default + persisted user keybindings once (E4-03/E4-04).
  useEffect(() => {
    setDefaults(DEFAULT_KEYBINDINGS.map((b) => ({ ...b, source: 'default' })))
    setUser(loadUserKeybindings())
  }, [setDefaults, setUser])

  // (Re)register chrome commands whenever the action closures change.
  useEffect(() => {
    const defs: Command[] = [
      {
        id: 'workbench.action.showCommands',
        title: 'Show All Commands',
        category: 'View',
        handler: () => actions.openPalette('>'),
      },
      {
        id: 'workbench.action.quickOpen',
        title: 'Go to File…',
        category: 'View',
        handler: () => actions.openPalette(''),
      },
      {
        id: 'workbench.action.quickOpenFiles',
        title: 'Quick Open',
        category: 'View',
        handler: () => actions.openPalette(''),
      },
      {
        id: 'workbench.action.togglePanel',
        title: 'Toggle Bottom Panel',
        category: 'View',
        handler: () => actions.togglePanel(),
      },
      {
        id: 'workbench.action.openSettings',
        title: 'Open Settings',
        category: 'Preferences',
        handler: () => actions.openSettings(),
      },
      {
        id: 'workbench.action.openGlobalKeybindings',
        title: 'Open Keyboard Shortcuts',
        category: 'Preferences',
        handler: () => actions.openKeybindings(),
      },
      {
        id: 'workbench.action.selectTheme',
        title: 'Color Theme: Cycle',
        category: 'Preferences',
        handler: () => {
          const s = useSettingsStore.getState()
          // All registered themes (base + plugin-contributed) then "system".
          const ids = [...allThemes().map((t) => t.id), 'system']
          const cur = s.settings['workbench.colorTheme']
          const idx = ids.indexOf(cur)
          s.set('workbench.colorTheme', ids[(idx + 1) % ids.length])
        },
      },
      {
        id: 'workbench.action.newProject',
        title: 'New Project',
        category: 'File',
        handler: () => actions.newProject(),
      },
      {
        id: 'workbench.view.explorer',
        title: 'Show Explorer',
        category: 'View',
        handler: () => actions.nav('ide'),
      },
      {
        id: 'workbench.view.scm',
        title: 'Show Source Control',
        category: 'View',
        handler: () => actions.nav('scm'),
      },
      {
        id: 'workbench.view.search',
        title: 'Search: Find in Files',
        category: 'View',
        handler: () => actions.openSearch(),
      },
      {
        id: 'workbench.view.plugins',
        title: 'Show Plugins',
        category: 'View',
        handler: () => actions.nav('plugins'),
      },
      {
        id: 'workbench.action.openTerminal',
        title: 'Open Terminal',
        category: 'Terminal',
        handler: () => actions.nav('term'),
      },
      {
        id: 'workbench.action.toggleZenMode',
        title: 'Toggle Zen Mode',
        category: 'View',
        handler: () => actions.toggleZen(),
      },
      {
        id: 'workbench.action.toggleActivityBarVisibility',
        title: 'Toggle Activity Bar',
        category: 'View',
        handler: () => {
          const s = useSettingsStore.getState()
          s.set('workbench.activityBar.visible', !s.settings['workbench.activityBar.visible'])
        },
      },
      {
        id: 'workbench.action.toggleStatusbarVisibility',
        title: 'Toggle Status Bar',
        category: 'View',
        handler: () => {
          const s = useSettingsStore.getState()
          s.set('workbench.statusBar.visible', !s.settings['workbench.statusBar.visible'])
        },
      },
      {
        id: 'workbench.actions.view.problems',
        title: 'Focus Problems',
        category: 'View',
        handler: () => actions.showProblems(),
      },
      {
        id: 'workbench.view.debug',
        title: 'Show Run and Debug',
        category: 'View',
        handler: () => actions.openDebug(),
      },
      {
        id: 'workbench.action.debug.start',
        title: 'Start / Continue Debugging',
        category: 'Debug',
        handler: () => {
          const d = useDebugStore.getState()
          if (d.status === 'stopped') void d.resume()
          else actions.openDebug()
        },
      },
      {
        id: 'workbench.action.debug.stop',
        title: 'Stop Debugging',
        category: 'Debug',
        handler: () => void useDebugStore.getState().stop(),
      },
      {
        id: 'workbench.action.debug.stepOver',
        title: 'Step Over',
        category: 'Debug',
        handler: () => void useDebugStore.getState().next(),
      },
      {
        id: 'workbench.action.debug.stepInto',
        title: 'Step Into',
        category: 'Debug',
        handler: () => void useDebugStore.getState().stepIn(),
      },
      {
        id: 'workbench.action.debug.stepOut',
        title: 'Step Out',
        category: 'Debug',
        handler: () => void useDebugStore.getState().stepOut(),
      },
    ]
    const disposers = defs.map((d) => register(d))
    return () => disposers.forEach((dispose) => dispose())
  }, [actions, register])
}
