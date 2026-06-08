/**
 * Editor commands (E1).
 *
 * Registers the editor-surface commands into the registry, mapping each to a
 * built-in Monaco action on the focused editor (find, replace, rename,
 * go-to-symbol, fold, format, problem navigation) or to a settings toggle
 * (word wrap, minimap, sticky scroll).
 *
 * Commands are intentionally NOT gated on `editorFocus` so they stay visible
 * in the command palette even though opening the palette blurs the editor —
 * `runEditorAction` simply no-ops when no editor is around. The *keybindings*
 * (DEFAULT_KEYBINDINGS) carry the `editorFocus` when-clause instead, so chords
 * like ⌘F only fire while the editor has focus.
 */

import { useEffect } from 'react'

import { getActiveEditor, runEditorAction } from './activeEditor'
import { useCommandStore, type Command } from '../store/commandStore'
import { useSettingsStore } from '../store/settingsStore'
import { useBreakpointsStore } from '../store/breakpointsStore'
import { useBlameStore } from '../store/blameStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useReferencesStore } from '../store/referencesStore'
import { queryReferences } from './references'
import type { Settings } from '../../../types/settings'

/** Resolve the focused editor's file path + cursor line, if any. */
function activeFileLine(): { path: string; line: number } | null {
  const ed = getActiveEditor()
  const pos = ed?.getPosition()
  const model = ed?.getModel()
  if (!ed || !pos || !model) return null
  return { path: model.uri.fsPath, line: pos.lineNumber }
}

/** Flip a boolean setting. */
function toggleBool(key: keyof Settings): void {
  const s = useSettingsStore.getState()
  const cur = s.settings[key]
  if (typeof cur === 'boolean') s.set(key, !cur as never)
}

export function useEditorCommands(enabled = true): void {
  const register = useCommandStore((s) => s.register)
  useEffect(() => {
    if (!enabled) return
    const action = (id: string) => () => {
      runEditorAction(id)
    }
    const defs: Command[] = [
      {
        id: 'editor.action.find',
        title: 'Find',
        category: 'Editor',
        handler: action('actions.find'),
      },
      {
        id: 'editor.action.replace',
        title: 'Replace',
        category: 'Editor',
        handler: action('editor.action.startFindReplaceAction'),
      },
      {
        id: 'editor.action.rename',
        title: 'Rename Symbol',
        category: 'Editor',
        handler: action('editor.action.rename'),
      },
      {
        id: 'editor.action.gotoSymbol',
        title: 'Go to Symbol in Editor…',
        category: 'Go',
        handler: action('editor.action.quickOutline'),
      },
      {
        id: 'editor.action.findReferences',
        title: 'Find All References',
        category: 'Go',
        handler: () => {
          void queryReferences().then(({ symbol, hits }) =>
            useReferencesStore.getState().show(symbol, hits),
          )
        },
      },
      {
        id: 'editor.action.formatDocument',
        title: 'Format Document',
        category: 'Editor',
        handler: action('editor.action.formatDocument'),
      },
      {
        id: 'editor.action.quickFix',
        title: 'Quick Fix…',
        category: 'Editor',
        handler: action('editor.action.quickFix'),
      },
      {
        id: 'editor.action.organizeImports',
        title: 'Organize Imports',
        category: 'Editor',
        handler: action('editor.action.organizeImports'),
      },
      {
        id: 'editor.action.sourceAction',
        title: 'Source Action…',
        category: 'Editor',
        handler: action('editor.action.sourceAction'),
      },
      {
        id: 'editor.action.marker.next',
        title: 'Go to Next Problem',
        category: 'Go',
        handler: action('editor.action.marker.next'),
      },
      {
        id: 'editor.action.marker.prev',
        title: 'Go to Previous Problem',
        category: 'Go',
        handler: action('editor.action.marker.prev'),
      },
      {
        id: 'editor.action.jumpToBracket',
        title: 'Go to Bracket',
        category: 'Editor',
        handler: action('editor.action.jumpToBracket'),
      },
      {
        id: 'editor.action.selectToBracket',
        title: 'Select to Bracket',
        category: 'Editor',
        handler: action('editor.action.selectToBracket'),
      },
      {
        id: 'editor.foldAll',
        title: 'Fold All',
        category: 'Editor',
        handler: action('editor.foldAll'),
      },
      {
        id: 'editor.unfoldAll',
        title: 'Unfold All',
        category: 'Editor',
        handler: action('editor.unfoldAll'),
      },
      {
        id: 'editor.action.toggleWordWrap',
        title: 'Toggle Word Wrap',
        category: 'View',
        handler: () => {
          const s = useSettingsStore.getState()
          s.set('editor.wordWrap', s.settings['editor.wordWrap'] === 'off' ? 'on' : 'off')
        },
      },
      {
        id: 'editor.action.toggleMinimap',
        title: 'Toggle Minimap',
        category: 'View',
        handler: () => toggleBool('editor.minimap'),
      },
      {
        id: 'editor.action.toggleStickyScroll',
        title: 'Toggle Sticky Scroll',
        category: 'View',
        handler: () => toggleBool('editor.stickyScroll'),
      },
      {
        id: 'git.toggleBlame',
        title: 'Toggle Git Blame (current file)',
        category: 'Source Control',
        handler: () => {
          const at = activeFileLine()
          if (!at) return
          const blame = useBlameStore.getState()
          if (blame.isEnabled(at.path)) {
            blame.disable(at.path)
            return
          }
          const repos = useWorkspaceStore.getState().repos
          const repo = repos.find((r) => {
            const sep = r.path.includes('\\') ? '\\' : '/'
            return at.path === r.path || at.path.startsWith(r.path + sep)
          })
          if (!repo) return
          const sep = repo.path.includes('\\') ? '\\' : '/'
          const rel = at.path.slice(repo.path.length + 1).split(sep).join('/')
          void window.hive.git
            .blame(repo.path, rel)
            .then((lines) => {
              useBlameStore.getState().setBlame(at.path, lines)
              useBlameStore.getState().enable(at.path)
            })
            .catch(() => undefined)
        },
      },
      {
        id: 'editor.debug.toggleBreakpoint',
        title: 'Toggle Breakpoint',
        category: 'Debug',
        handler: () => {
          const at = activeFileLine()
          if (at) useBreakpointsStore.getState().toggle(at.path, at.line)
        },
      },
      {
        id: 'editor.debug.addConditionalBreakpoint',
        title: 'Add Conditional Breakpoint…',
        category: 'Debug',
        handler: () => {
          const at = activeFileLine()
          if (!at) return
          const condition = window.prompt('Breakpoint condition (expression):')
          if (condition && condition.trim()) {
            useBreakpointsStore
              .getState()
              .setBreakpoint(at.path, { line: at.line, condition: condition.trim() })
          }
        },
      },
      {
        id: 'editor.debug.addLogpoint',
        title: 'Add Logpoint…',
        category: 'Debug',
        handler: () => {
          const at = activeFileLine()
          if (!at) return
          const logMessage = window.prompt('Log message (use {expr} to interpolate):')
          if (logMessage && logMessage.trim()) {
            useBreakpointsStore
              .getState()
              .setBreakpoint(at.path, { line: at.line, logMessage: logMessage.trim() })
          }
        },
      },
    ]
    const disposers = defs.map((d) => register(d))
    return () => disposers.forEach((dispose) => dispose())
  }, [register, enabled])
}
