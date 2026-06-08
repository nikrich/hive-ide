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

export interface ChromeCommandActions {
  /** Open the command palette, optionally pre-filling the query. */
  openPalette: (initialQuery?: string) => void
  /** Toggle the bottom panel open/closed. */
  togglePanel: () => void
  /** Open the settings editor. */
  openSettings: () => void
  /** Open the New Project modal. */
  newProject: () => void
  /** Navigate the workarea (mirrors App's `nav`). */
  nav: (target: string) => void
}

export function useChromeCommands(actions: ChromeCommandActions): void {
  const register = useCommandStore((s) => s.register)
  const setDefaults = useKeybindingStore((s) => s.setDefaults)

  // Load default keybindings once.
  useEffect(() => {
    setDefaults(DEFAULT_KEYBINDINGS.map((b) => ({ ...b, source: 'default' })))
  }, [setDefaults])

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
    ]
    const disposers = defs.map((d) => register(d))
    return () => disposers.forEach((dispose) => dispose())
  }, [actions, register])
}
