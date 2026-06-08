/**
 * Hive IDE — application shell (STORY-028).
 *
 * Final wiring: the shell stops being a beautiful mockup and starts being a
 * real desktop IDE. Routing, persistence, and every editor interaction now
 * go through the Zustand workspace store + the `window.hive.*` preload
 * bridge. The seed `FILE_CONTENTS` / `tree` / `openTabs` / `AGENT_FILE`
 * streaming demo is gone — replaced by real filesystem reads + real saves.
 *
 * Routing
 * -------
 * - `store.project === null`            → Welcome (the `ProjectsHub` view).
 * - `store.project !== null`            → IDE shell (Explorer + Editor +
 *                                         Dock + BottomPanel).
 * - The `prs` and `hub` sub-views are reachable while a project is open via
 *   the activity rail / command palette — they're swapped over the IDE
 *   workarea via the `view` state machine.
 *
 * Boot sequence (on mount)
 * ------------------------
 * 1. `window.hive.state.get()` → load persisted state.
 * 2. Replace the store's recents list with whatever was on disk.
 * 3. If `lastProjectId` resolves to a `ProjectSession` AND its `rootPath`
 *    still exists on disk → re-detect (so the project gets a fresh repo
 *    list), set it on the store, hydrate the session (expandedSet +
 *    openTabs + activeTabPath).
 * 4. Otherwise → stay on Welcome.
 *
 * Persistence lifecycle
 * ---------------------
 * - On any workspace-store change → debounced `state.save(snapshot)`.
 * - A 5-second interval-while-editing also fires `state.save` as a
 *   defence in depth in case `subscribe` misses an edge.
 * - On `beforeunload` → one last synchronous flush so the next launch
 *   sees the most recent tabs.
 *
 * Mocked panels (Dock, BottomPanel, PRsView, AgentDock) keep their existing
 * seed-driven data — they still render `roster`, `board`, `log`, `problems`,
 * `prs` from `data/seed`. The "mock data — Hive not connected" ribbons added
 * by STORY-029 stay. The Hive REQ rewires them.
 *
 * No `any` is permitted anywhere in this file.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import { Dock } from './components/AgentDock'
import { BottomPanel, type BottomPanelTab } from './components/BottomPanel'
import { CommandPalette } from './components/CommandPalette'
import { EditorArea } from './components/EditorArea'
import { Explorer } from './components/Explorer'
import { PluginsView } from './components/PluginsView'
import { ProjectsHub } from './components/ProjectsHub'
import { TerminalView } from './components/TerminalView'
import NewProjectModal from './components/NewProjectModal'
import { SettingsView } from './components/SettingsView'
import { SearchView } from './components/SearchView'
import { DebugView } from './components/DebugView'
import { KeybindingsEditor } from './components/KeybindingsEditor'
import { Notifications } from './components/Notifications'
import SourceControlView from './components/SourceControlView'
import { Splitter } from './components/Splitter'
import { StatusBar } from './components/StatusBar'
import { Icon, InlineEditable } from './components/primitives'
import { formatRelativeTime } from './lib/relativeTime'
import { useHiveSession, useHiveSessionStore } from './lib/useHiveSession'
import { toBoard, toLogLines, toRoster } from './lib/hiveView'
import { useProjectWatchers } from './lib/useProjectWatchers'
import { useSettingsBoot } from './lib/useSettings'
import { useChromeCommands } from './lib/useChromeCommands'
import { useGlobalKeybindings } from './lib/useGlobalKeybindings'
import { usePluginContributions } from './lib/usePluginContributions'
import { useDebugEvents } from './lib/useDebugEvents'
import { useRecommendations } from './lib/useRecommendations'
import { useTheme } from './lib/useTheme'
import { useCommandStore } from './store/commandStore'
import { useThemeStore } from './store/themeStore'
import { useSettingsStore } from './store/settingsStore'
import { useNotificationsStore } from './store/notificationsStore'
import type {
  OpenTab,
  PersistedState,
  ProjectSession,
  RecentEntry,
} from '../../types/workspace'
import type { HiveConnection } from '../../types/hive'
import { DEFAULT_LAYOUT, useWorkspaceStore } from './store/workspaceStore'
import type { Agent, Board, LogLine } from './data/seed'
import { chat } from './data/seed'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The three top-level views the workarea routes between. The activity rail
 * and command palette both feed into the same `setView` setter — but only
 * while a project is mounted. With no project, the shell unconditionally
 * renders Welcome regardless of `view`.
 */
type ViewKey = 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'

/** Activity-rail entry definitions. */
interface RailEntry {
  key: string
  icon: string
  label: string
  /** Optional view target — clicking the entry navigates here. */
  view?: ViewKey
  /** Optional custom action — takes precedence over `view`. */
  action?: () => void
  /** Optional badge number shown over the icon. */
  badge?: number
}

/** Debounce delay before flushing a store change to disk via state.save. */
const SAVE_DEBOUNCE_MS = 500

/** Heartbeat save while editing — defence in depth against missed events. */
const SAVE_HEARTBEAT_MS = 5_000

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Build the snapshot the main process persists. Pulls the latest values
 * straight off the store rather than relying on a React render — the
 * `beforeunload` flush path runs outside any React commit.
 */
function buildSnapshot(prev: PersistedState | null): PersistedState {
  const s = useWorkspaceStore.getState()

  // Carry forward existing per-project sessions; the active project gets
  // its slot rewritten below.
  const projectsMap: Record<string, ProjectSession> = prev
    ? { ...prev.projects }
    : {}

  if (s.project) {
    const session: ProjectSession = {
      id: s.project.id,
      name: s.project.name,
      repos: s.project.repos,
      createdAt: s.project.createdAt,
      lastOpenedAt: s.project.lastOpenedAt,
      hiveWorkspacePath: s.project.hiveWorkspacePath,
      expandedPaths: Array.from(s.expandedSet),
      openTabs: s.openTabs.map((t: OpenTab) => ({
        path: t.path,
        viewState: t.viewState,
      })),
      activeTabPath: s.activeTabPath,
      secondaryTabs: s.secondaryTabs.map((t: OpenTab) => ({
        path: t.path,
        viewState: t.viewState,
      })),
      secondaryActiveTabPath: s.secondaryActiveTabPath,
      activeView: s.activeView,
      panelOpen: s.panelOpen,
      panelTab: s.panelTab,
    }
    projectsMap[s.project.id] = session
  }

  return {
    schemaVersion: 6,
    lastProjectId: s.project?.id ?? prev?.lastProjectId ?? null,
    recents: s.recents,
    projects: projectsMap,
    layout: {
      explorerWidth: s.explorerWidth,
      dockWidth: s.dockWidth,
      panelHeight: s.panelHeight,
    },
    enabledPlugins:
      s.enabledPlugins ?? prev?.enabledPlugins ?? {},
    // Workspace-global terminal state (REQ-010) — read straight off the store.
    terminals: {
      panelTerminals: s.panelTerminals,
      activePanelTerminalId: s.activePanelTerminalId,
      termSessions: s.termSessions,
      activeTermSessionId: s.activeTermSessionId,
    },
    window: prev?.window ?? { width: 1440, height: 900 },
  }
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** REQ-005 — clamp bounds for the three resizable panels. */
const EXPLORER_MIN = 180
const EXPLORER_MAX = 600
const DOCK_MIN = 220
const DOCK_MAX = 640
const PANEL_MIN = 120
/** Hard ceiling, refined per-render by `maxPanelHeight` based on container. */
const PANEL_MAX_ABSOLUTE = 1200
/** Fraction of the IDE container the bottom panel may occupy. */
const PANEL_MAX_FRACTION = 0.7

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  // -------------------------------- workspace store
  const project = useWorkspaceStore((s) => s.project)
  const setProject = useWorkspaceStore((s) => s.setProject)
  const hydrateFromSession = useWorkspaceStore((s) => s.hydrateFromSession)
  const hydrateLayout = useWorkspaceStore((s) => s.hydrateLayout)
  const hydrateTerminals = useWorkspaceStore((s) => s.hydrateTerminals)
  const hydrateEnabledPlugins = useWorkspaceStore((s) => s.hydrateEnabledPlugins)
  const setPlugins = useWorkspaceStore((s) => s.setPlugins)
  const openTab = useWorkspaceStore((s) => s.openTab)
  const pushRecent = useWorkspaceStore((s) => s.pushRecent)
  const fetchAllScm = useWorkspaceStore((s) => s.fetchAllScm)

  // Start filesystem watchers for the active project's repos so external
  // edits auto-sync into the IDE (REQ-002 external-change pipeline).
  useProjectWatchers()

  // Subscribe to the active project's live hive session (slice 1 viewer).
  useHiveSession()

  // Load + live-sync user settings (E4-01).
  useSettingsBoot()

  // Resolve + apply the colour theme (E8).
  useTheme()
  const chromeTheme = useThemeStore((s) => s.chrome)
  const iconTheme = useSettingsStore((s) => s.settings['workbench.iconTheme'])
  const railVisible = useSettingsStore((s) => s.settings['workbench.activityBar.visible'])

  // -------------------------------- live hive state
  const hiveConnection = useHiveSessionStore((s) => s.connection)
  const hiveSnapshot = useHiveSessionStore((s) => s.snapshot)
  const hiveEvents = useHiveSessionStore((s) => s.events)
  const setHiveWorkspacePath = useWorkspaceStore((s) => s.setHiveWorkspacePath)

  const liveRoster = useMemo(() => toRoster(hiveSnapshot.agents), [hiveSnapshot.agents])
  const liveBoard = useMemo(() => toBoard(hiveSnapshot.stories), [hiveSnapshot.stories])
  const liveLog = useMemo(() => toLogLines(hiveEvents), [hiveEvents])

  const onConnectHive = useCallback(async () => {
    const bridge = window.hive?.orchestration
    if (!bridge) return
    const { connection } = await bridge.connectWorkspace()
    if (connection.state === 'connected') {
      setHiveWorkspacePath(connection.path)
    } else if (connection.state === 'not-found') {
      useHiveSessionStore.getState().setConnection(connection)
    }
  }, [setHiveWorkspacePath])

  // -------------------------------- layout (REQ-005)
  const explorerWidth = useWorkspaceStore((s) => s.explorerWidth)
  const dockWidth = useWorkspaceStore((s) => s.dockWidth)
  const panelHeight = useWorkspaceStore((s) => s.panelHeight)
  const setExplorerWidth = useWorkspaceStore((s) => s.setExplorerWidth)
  const setDockWidth = useWorkspaceStore((s) => s.setDockWidth)
  const setPanelHeight = useWorkspaceStore((s) => s.setPanelHeight)

  // -------------------------------- routing (only meaningful when a project is open)
  // Routing + bottom-panel chrome now live in the workspace store so they
  // persist/restore per project alongside tabs + layout.
  const view = useWorkspaceStore((s) => s.activeView)
  const setView = useWorkspaceStore((s) => s.setActiveView)
  const panelOpen = useWorkspaceStore((s) => s.panelOpen)
  const setPanelOpen = useWorkspaceStore((s) => s.setPanelOpen)
  const panelTab = useWorkspaceStore((s) => s.panelTab)
  const setPanelTab = useWorkspaceStore((s) => s.setPanelTab)
  const renameProject = useWorkspaceStore((s) => s.renameProject)

  // The full-screen terminal view is mounted lazily on first visit and then
  // kept mounted (hidden) so its live pty sessions survive view switches —
  // same persistence contract as IdeLayout's bottom-panel terminal.
  const [termMounted, setTermMounted] = useState(false)
  useEffect(() => {
    if (view === 'term') setTermMounted(true)
  }, [view])

  // -------------------------------- chrome state (palette + project menu)
  const [palette, setPalette] = useState(false)
  /** Initial query to seed the palette with (e.g. '>' for commands mode). */
  const [paletteQuery, setPaletteQuery] = useState('')
  const [projMenu, setProjMenu] = useState(false)
  // Settings editor (E4-02) + Search (E2-02) — workarea overlays.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // Zen mode (E11-11) — hide rail + status bar to focus on the editor.
  const [zen, setZen] = useState(false)
  // Keyboard-shortcuts editor overlay (E4-04).
  const [keybindingsOpen, setKeybindingsOpen] = useState(false)
  // Run & Debug overlay (E3).
  const [debugOpen, setDebugOpen] = useState(false)
  // Notifications center (E11-09).
  const [notifOpen, setNotifOpen] = useState(false)
  const notifUnread = useNotificationsStore((s) => s.unread)
  const markNotifRead = useNotificationsStore((s) => s.markRead)

  const openPalette = useCallback((initialQuery = ''): void => {
    setPaletteQuery(initialQuery)
    setPalette(true)
  }, [])

  // -------------------------------- persisted-state cache
  // Cached so save snapshots can carry forward fields we don't manage
  // (e.g. `window` bounds) without re-fetching from main each time.
  const persistedRef = useRef<PersistedState | null>(null)

  // -------------------------------- boot: hydrate from main
  useEffect(() => {
    let cancelled = false

    async function boot(): Promise<void> {
      try {
        const persisted = await window.hive.state.get()
        if (cancelled) return
        persistedRef.current = persisted

        // Seed the store's recents list from disk so the Welcome screen
        // (and the title-bar switcher) render the real history.
        useWorkspaceStore.setState({ recents: persisted.recents })

        // REQ-005 — restore IDE chrome layout from disk if present, else
        // leave the store's compile-time defaults. The migrator guarantees
        // `persisted.layout` exists for v3+ payloads.
        if (persisted.layout) {
          hydrateLayout(persisted.layout)
        } else {
          hydrateLayout(DEFAULT_LAYOUT)
        }

        // REQ-010 — restore the workspace-global terminal state. Migrated
        // payloads always carry `terminals`; guard for older shapes anyway.
        hydrateTerminals(
          persisted.terminals ?? {
            panelTerminals: [],
            activePanelTerminalId: null,
            termSessions: [],
            activeTermSessionId: null,
          },
        )

        // REQ-006 — restore the per-project enabled-plugins map from
        // disk, then refresh the live plugin snapshot. We do both in
        // parallel because `enabledPlugins` is just persisted state
        // (no IPC) and the `plugins.list()` round-trip can take a
        // moment when there are many on disk.
        if (persisted.enabledPlugins) {
          hydrateEnabledPlugins(persisted.enabledPlugins)
        }
        void window.hive.plugins
          .list()
          .then((live) => {
            if (!cancelled) setPlugins(live)
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('plugins.list failed', err)
          })

        const lastId = persisted.lastProjectId
        if (!lastId) return
        const session = persisted.projects[lastId]
        if (!session || cancelled) return

        // Re-hydrate the project from its persisted session — no disk
        // detection needed under REQ-003 (projects are explicit containers,
        // not folders). Repos that have been removed from disk simply fail
        // when the explorer tries to list them; we don't pre-validate.
        const restored = {
          id: session.id,
          name: session.name,
          repos: session.repos,
          createdAt: session.createdAt,
          lastOpenedAt: Date.now(),
          hiveWorkspacePath: session.hiveWorkspacePath,
        }
        setProject(restored)
        hydrateFromSession({
          expandedPaths: session.expandedPaths,
          openTabs: session.openTabs.map((t) => ({
            path: t.path,
            viewState: t.viewState,
            dirty: false,
          })),
          activeTabPath: session.activeTabPath,
          secondaryTabs: (session.secondaryTabs ?? []).map((t) => ({
            path: t.path,
            viewState: t.viewState,
            dirty: false,
          })),
          secondaryActiveTabPath: session.secondaryActiveTabPath ?? null,
          activeView: session.activeView,
          panelOpen: session.panelOpen,
          panelTab: session.panelTab,
        })

        // Refresh the recents entry so the rehydrated project also bubbles
        // to the top of the list.
        pushRecent({
          id: restored.id,
          name: restored.name,
          repoCount: restored.repos.length,
          lastOpenedAt: Date.now(),
        })
      } catch (err) {
        // Boot failures shouldn't deadlock the UI — just stay on Welcome.
        // eslint-disable-next-line no-console
        console.error('boot: state.get failed', err)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [
    hydrateEnabledPlugins,
    hydrateFromSession,
    hydrateLayout,
    hydrateTerminals,
    pushRecent,
    setPlugins,
    setProject,
  ])

  // -------------------------------- REQ-008: refresh SCM whenever the active
  // project changes so the rail badge + status bar branch chip light up
  // without the user having to open the Source Control view.
  useEffect(() => {
    if (project === null) return
    void fetchAllScm()
  }, [project, fetchAllScm])

  // -------------------------------- persistence: subscribe → debounced save
  useEffect(() => {
    let timer: number | null = null
    const flush = (): void => {
      timer = null
      const snapshot = buildSnapshot(persistedRef.current)
      persistedRef.current = snapshot
      void window.hive.state.save(snapshot).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('state.save failed', err)
      })
    }

    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    }

    const unsubscribe = useWorkspaceStore.subscribe(schedule)
    return () => {
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  // -------------------------------- persistence: heartbeat while editing
  useEffect(() => {
    const id = window.setInterval(() => {
      const snapshot = buildSnapshot(persistedRef.current)
      persistedRef.current = snapshot
      void window.hive.state.save(snapshot).catch(() => {
        // Heartbeat failures are non-fatal; the subscribe path will retry.
      })
    }, SAVE_HEARTBEAT_MS)
    return () => window.clearInterval(id)
  }, [])

  // -------------------------------- persistence: synchronous flush on quit
  useEffect(() => {
    function onBeforeUnload(): void {
      const snapshot = buildSnapshot(persistedRef.current)
      persistedRef.current = snapshot
      // Best-effort fire-and-forget — Electron's renderer will keep the
      // promise alive long enough for main to receive the IPC even if
      // the page is tearing down.
      void window.hive.state.save(snapshot)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // New Project modal open state. The ⌘⇧N binding now lives in the command +
  // keybinding registry (see useChromeCommands / DEFAULT_KEYBINDINGS).
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  // -------------------------------- callbacks shared with mocked panels
  // The seed Dock / BottomPanel / PRsView / CommandPalette accept an
  // `onOpenFile` callback. With real files, "open" means open a tab at
  // the supplied absolute path. The mocked panels still ship seed `Story.file`
  // values that are relative — for them, opening a non-existent path will
  // surface as an explorer-level miss; we accept that visual regression until
  // the Hive REQ wires real story data.
  const onOpenFile = useCallback(
    (path: string): void => {
      setView('ide')
      openTab(path)
    },
    [openTab],
  )

  // -------------------------------- navigation
  // Re-enter a project from the recents list. Under REQ-003, projects are
  // explicit user-named containers — there's no folder to re-detect, so
  // restoring is purely a session-rehydration step against the persisted
  // ProjectSession.
  const enterRecent = useCallback(
    (id: string, opts?: { keepView?: boolean }): void => {
      setProjMenu(false)
      const session = persistedRef.current?.projects[id]
      if (!session) return

      // Capture the current view before the project swap resets it, so the
      // title-bar switcher can keep the user where they are (keepView) instead
      // of jumping to the code view.
      const prevView = useWorkspaceStore.getState().activeView

      const restored = {
        id: session.id,
        name: session.name,
        repos: session.repos,
        createdAt: session.createdAt,
        lastOpenedAt: Date.now(),
        hiveWorkspacePath: session.hiveWorkspacePath,
      }
      setProject(restored)
      pushRecent({
        id: restored.id,
        name: restored.name,
        repoCount: restored.repos.length,
        lastOpenedAt: Date.now(),
      })
      hydrateFromSession({
        expandedPaths: session.expandedPaths,
        openTabs: session.openTabs.map((t) => ({
          path: t.path,
          viewState: t.viewState,
          dirty: false,
        })),
        activeTabPath: session.activeTabPath,
        activeView: session.activeView,
        panelOpen: session.panelOpen,
        panelTab: session.panelTab,
      })
      // Title-bar switch keeps the current view (no jarring jump to code);
      // hub / command-palette entries open into the code view.
      setView(opts?.keepView ? prevView : 'ide')
    },
    [hydrateFromSession, pushRecent, setProject, setView],
  )

  const nav = useCallback(
    (target: string): void => {
      setPalette(false)
      if (target === 'hub') return setView('hub')
      if (target === 'plugins') return setView('plugins')
      if (target === 'scm') return setView('scm')
      if (target === 'term') return setView('term')
      if (target === 'terminal') {
        setPanelOpen(true)
        setPanelTab('terminal')
        return
      }
      if (target.startsWith('proj:')) {
        void enterRecent(target.slice(5))
        return
      }
      setView('ide')
    },
    [enterRecent],
  )

  // -------------------------------- command + keybinding registry (E6, E4-03)
  const togglePanel = useCallback(
    () => setPanelOpen(!useWorkspaceStore.getState().panelOpen),
    [setPanelOpen],
  )
  const chromeActions = useMemo(
    () => ({
      openPalette,
      togglePanel,
      openSettings: () => setSettingsOpen(true),
      openSearch: () => setSearchOpen(true),
      openDebug: () => setDebugOpen(true),
      toggleZen: () => setZen((v) => !v),
      openKeybindings: () => setKeybindingsOpen(true),
      newProject: () => setNewProjectOpen(true),
      showProblems: () => {
        setPanelOpen(true)
        setPanelTab('problems')
      },
      nav,
    }),
    [openPalette, togglePanel, nav, setPanelOpen, setPanelTab],
  )
  useChromeCommands(chromeActions)
  useGlobalKeybindings(window.hive?.platform ?? 'darwin')
  usePluginContributions()
  useDebugEvents()
  const showPluginsView = useCallback(() => nav('plugins'), [nav])
  useRecommendations(showPluginsView)

  // Keep when-clause context keys in sync with App state so command/keybinding
  // gating (e.g. editorFocus, view==scm) stays current.
  const setContextBatch = useCommandStore((s) => s.setContextBatch)
  useEffect(() => {
    setContextBatch({
      hasProject: project !== null,
      view,
      panelOpen,
    })
  }, [project, view, panelOpen, setContextBatch])

  // -------------------------------- source-control summary (for rail badge + status chip)
  const scmMap = useWorkspaceStore((s) => s.scm)
  const scmTotalChanges = useMemo(() => {
    let n = 0
    for (const slot of Object.values(scmMap)) {
      if (!slot) continue
      // Each modified file may appear twice (staged + unstaged). The badge
      // here is a visual hint; "approximate" is good enough.
      const seen = new Set<string>()
      for (const e of slot.entries) {
        seen.add(e.path)
      }
      n += seen.size
    }
    return n
  }, [scmMap])

  // -------------------------------- activity rail
  const rail: ReadonlyArray<RailEntry> = useMemo(
    () => [
      { key: 'explorer', icon: 'files', label: 'Explorer', view: 'ide' },
      {
        key: 'search',
        icon: 'search',
        label: 'Search',
        action: () => setSearchOpen(true),
      },
      {
        key: 'scm',
        icon: 'git-branch',
        label: 'Source Control',
        view: 'scm',
        badge: scmTotalChanges,
      },
      {
        key: 'debug',
        icon: 'bug',
        label: 'Run and Debug',
        action: () => setDebugOpen(true),
      },
      { key: 'hub', icon: 'layout-grid', label: 'Projects', view: 'hub' },
      { key: 'term', icon: 'square-terminal', label: 'Terminal', view: 'term' },
      { key: 'plugins', icon: 'package', label: 'Plugins', view: 'plugins' },
    ],
    [scmTotalChanges],
  )

  const railActive = useCallback(
    (k: string): boolean =>
      (k === 'explorer' && view === 'ide') || k === view,
    [view],
  )

  // -------------------------------- render

  // No project mounted → Welcome only. The chrome (titlebar / rail / status
  // bar) still renders so the user can reach the title-bar Open Folder
  // dropdown + the ⌘O shortcut.
  const showWelcomeOnly = project === null

  return (
    <div
      className="shell"
      data-accent="indigo"
      data-density="comfortable"
      data-theme={chromeTheme}
      data-icons={iconTheme}
      data-rail={railVisible ? undefined : 'hidden'}
      data-zen={zen ? 'on' : undefined}
      data-platform={window.hive?.platform ?? 'darwin'}
    >
      {/* ----- title bar ----- */}
      <div className="titlebar">
        <div className="tb-brand">
          <img src="./hive-mark.png" alt="" />
          <span className="nm">
            Hive <span className="d">IDE</span>
          </span>
        </div>
        <div
          className="proj-switch"
          onClick={() => setProjMenu((m) => !m)}
          onDoubleClick={(e) => e.stopPropagation()}
          role="button"
          tabIndex={0}
        >
          <span
            className="proj-dot"
            style={{ background: 'var(--fg-3)' }}
          />
          {project ? (
            <InlineEditable
              className="pn"
              value={project.name}
              ariaLabel="Rename project"
              onCommit={(next) => renameProject(project.id, next)}
            />
          ) : (
            <span className="pn">No project</span>
          )}
          <Icon name="chevrons-up-down" size={14} />
        </div>
        <div className="tb-center">
          <div
            className="tb-search"
            onClick={() => openPalette('')}
            role="button"
            tabIndex={0}
          >
            <Icon name="search" size={14} /> Search files, projects, agents…
            <span className="kbd">⌘K</span>
          </div>
        </div>
        <div className="tb-right">
          <button
            className="ib-btn"
            title="Notifications"
            aria-label="Notifications"
            type="button"
            onClick={() => {
              setNotifOpen((v) => !v)
              markNotifRead()
            }}
          >
            <Icon name="bell" size={16} />
            {notifUnread > 0 && <span className="ib-badge">{notifUnread}</span>}
          </button>
          <button
            className="ib-btn"
            title="Settings"
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
      </div>

      {projMenu && (
        <ProjectMenu
          onPick={(id) => enterRecent(id, { keepView: true })}
          onClose={() => setProjMenu(false)}
          onHub={() => {
            setProjMenu(false)
            setView('hub')
          }}
          onNewProject={() => {
            setProjMenu(false)
            setNewProjectOpen(true)
          }}
        />
      )}

      {/* ----- body: rail + workarea ----- */}
      <div className="body">
        <nav className="rail" aria-label="Activity Bar">
          <div className="brand">
            <img src="./hive-mark.png" alt="Hive" />
          </div>
          {rail.map((r) => (
            <button
              key={r.key}
              className={'rail-btn' + (railActive(r.key) ? ' active' : '')}
              title={r.label}
              aria-label={r.label}
              aria-pressed={railActive(r.key)}
              type="button"
              onClick={() => (r.action ? r.action() : r.view && nav(r.view))}
            >
              <Icon name={r.icon} size={21} />
              {r.badge !== undefined && r.badge > 0 && (
                <span className="rail-badge">{r.badge}</span>
              )}
            </button>
          ))}
          <div className="rail-spacer" />
          <button className="rail-btn" title="Docs" type="button">
            <Icon name="book-open" size={21} />
          </button>
          <div className="rail-ava" title="You">
            JD
          </div>
        </nav>

        <div className="workarea" role="main" aria-label="Editor area">
          {showWelcomeOnly && view !== 'plugins' && view !== 'term' && (
            <ProjectsHub onEnter={(id) => void enterRecent(id)} />
          )}
          {showWelcomeOnly && view === 'plugins' && <PluginsView />}

          {!showWelcomeOnly && view === 'hub' && (
            <ProjectsHub onEnter={(id) => void enterRecent(id)} />
          )}
          {!showWelcomeOnly && view === 'plugins' && <PluginsView />}
          {!showWelcomeOnly && view === 'scm' && <SourceControlView />}
          {/*
            IdeLayout stays mounted for the whole time a project is open and
            is merely hidden when another view is active. Unmounting it on a
            view switch would tear down the BottomPanel → TerminalPanel and
            dispose every pty, killing the user's live shell sessions.
          */}
          {!showWelcomeOnly && (
            <IdeLayout
              hidden={view !== 'ide'}
              panelOpen={panelOpen}
              setPanelOpen={setPanelOpen}
              panelTab={panelTab}
              setPanelTab={setPanelTab}
              explorerWidth={explorerWidth}
              dockWidth={dockWidth}
              panelHeight={panelHeight}
              setExplorerWidth={setExplorerWidth}
              setDockWidth={setDockWidth}
              setPanelHeight={setPanelHeight}
              onOpenFile={onOpenFile}
              liveBoard={liveBoard}
              liveRoster={liveRoster}
              liveLog={liveLog}
              hiveConnection={hiveConnection}
              onConnectHive={onConnectHive}
            />
          )}

          {/*
            Full-screen terminal workspace. Mounted lazily on first visit,
            then kept mounted (hidden) so live shells survive view switches.
            Works with or without an open project (falls back to a local
            shell in the user's home directory).
          */}
          {termMounted && (
            <TerminalView active={view === 'term'} project={project} />
          )}

          {/* Settings editor (E4-02) — overlays the workarea when open. */}
          {settingsOpen && (
            <div className="settings-overlay">
              <SettingsView
                onClose={() => setSettingsOpen(false)}
                onOpenFile={(p) => {
                  setSettingsOpen(false)
                  onOpenFile(p)
                }}
              />
            </div>
          )}

          {/* Global search (E2-02) — overlays the workarea when open. */}
          {searchOpen && (
            <div className="settings-overlay">
              <SearchView onClose={() => setSearchOpen(false)} />
            </div>
          )}

          {/* Run & Debug (E3) — overlays the workarea when open. */}
          {debugOpen && (
            <div className="settings-overlay">
              <DebugView onClose={() => setDebugOpen(false)} />
            </div>
          )}

          {/* Keyboard shortcuts editor (E4-04) — overlay. */}
          {keybindingsOpen && (
            <div className="settings-overlay">
              <KeybindingsEditor onClose={() => setKeybindingsOpen(false)} />
            </div>
          )}
        </div>
      </div>

      {/* ----- status bar (indigo) — framework-driven (E11-01) ----- */}
      <StatusBar />

      {palette && (
        <CommandPalette
          initialQuery={paletteQuery}
          onClose={() => setPalette(false)}
          onNav={nav}
          onOpenFile={onOpenFile}
        />
      )}

      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} />
      )}

      <Notifications
        centerOpen={notifOpen}
        onCloseCenter={() => setNotifOpen(false)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// IdeLayout — the grid container for the IDE view (REQ-005).
//
// Extracted into its own component so we can attach a `ResizeObserver` to
// the container without re-rendering the whole shell on every container
// resize. The observer's only job is to compute the dynamic max for the
// bottom-panel height (clamp-on-resize, see PANEL_MAX_FRACTION) so the
// panel can't end up taller than the editor area after a window shrink.
// ---------------------------------------------------------------------------

interface IdeLayoutProps {
  /**
   * When true the layout stays mounted but is hidden (`display: none`).
   * The IDE view is kept mounted across activity-rail view switches so
   * terminal ptys (and editor / Monaco state) survive — unmounting it
   * would dispose every pty. See the workarea routing in `App`.
   */
  hidden: boolean
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  panelTab: BottomPanelTab
  setPanelTab: (tab: BottomPanelTab) => void
  explorerWidth: number
  dockWidth: number
  panelHeight: number
  setExplorerWidth: (px: number) => void
  setDockWidth: (px: number) => void
  setPanelHeight: (px: number) => void
  onOpenFile: (path: string) => void
  liveBoard: Board
  liveRoster: Agent[]
  liveLog: LogLine[]
  hiveConnection: HiveConnection
  onConnectHive: () => void
}

function IdeLayout({
  hidden,
  panelOpen,
  setPanelOpen,
  panelTab,
  setPanelTab,
  explorerWidth,
  dockWidth,
  panelHeight,
  setExplorerWidth,
  setDockWidth,
  setPanelHeight,
  onOpenFile,
  liveBoard,
  liveRoster,
  liveLog,
  hiveConnection,
  onConnectHive,
}: IdeLayoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerHeight, setContainerHeight] = useState<number>(0)

  // Observe container height so panelHeight max clamps dynamically as the
  // window resizes. If the new max is below the current height, the next
  // splitter drag (or the clamp below) will pull the panel down to fit.
  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      setContainerHeight(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Effective max for the bottom panel given the current container height.
  // Fall back to the absolute ceiling until the observer has fired.
  const maxPanelHeight =
    containerHeight > 0
      ? Math.max(PANEL_MIN, Math.floor(containerHeight * PANEL_MAX_FRACTION))
      : PANEL_MAX_ABSOLUTE

  // Clamp current panelHeight down on window shrink so the bottom panel
  // never spills over the editor area. Runs at most once per resize.
  useEffect(() => {
    if (panelHeight > maxPanelHeight) {
      setPanelHeight(maxPanelHeight)
    }
  }, [maxPanelHeight, panelHeight, setPanelHeight])

  // Drag deltas — clamped by the parent before they hit the store.
  // Dragging the dock splitter *right* should *shrink* the dock, hence the
  // sign flip. Same for the bottom panel: dragging *up* should *grow* it.
  const onExplorerDrag = useCallback(
    (d: number) => setExplorerWidth(clamp(explorerWidth + d, EXPLORER_MIN, EXPLORER_MAX)),
    [explorerWidth, setExplorerWidth],
  )
  const onDockDrag = useCallback(
    (d: number) => setDockWidth(clamp(dockWidth - d, DOCK_MIN, DOCK_MAX)),
    [dockWidth, setDockWidth],
  )
  const onPanelDrag = useCallback(
    (d: number) => setPanelHeight(clamp(panelHeight - d, PANEL_MIN, maxPanelHeight)),
    [maxPanelHeight, panelHeight, setPanelHeight],
  )

  return (
    <div
      ref={containerRef}
      className="ide"
      data-dock="shown"
      data-panel={panelOpen ? 'open' : 'closed'}
      style={
        {
          // Kept mounted but hidden while another view is active, so the
          // terminal ptys + editor state survive a rail/view switch.
          display: hidden ? 'none' : undefined,
          '--explorer-w': `${explorerWidth}px`,
          '--dock-w': `${dockWidth}px`,
          '--panel-h': panelOpen ? `${panelHeight}px` : '0px',
        } as CSSProperties & Record<`--${string}`, string>
      }
    >
      {/*
        Explorer + EditorGroup are fully store-driven — the App
        shell no longer threads tab / content / view-state plumbing.
      */}
      <Explorer />
      <Splitter
        orientation="vertical"
        className="explorer-splitter"
        ariaLabel="Resize file explorer"
        onDrag={onExplorerDrag}
      />
      <EditorArea />
      <Splitter
        orientation="vertical"
        className="dock-splitter"
        ariaLabel="Resize agent dock"
        onDrag={onDockDrag}
      />
      <Dock
        onOpenFile={onOpenFile}
        board={liveBoard}
        roster={liveRoster}
        chat={chat}
        hiveConnection={hiveConnection}
        onConnectHive={onConnectHive}
      />
      {panelOpen && (
        <>
          <Splitter
            orientation="horizontal"
            className="panel-splitter"
            ariaLabel="Resize bottom panel"
            onDrag={onPanelDrag}
          />
          <BottomPanel
            tab={panelTab}
            setTab={setPanelTab}
            onClose={() => setPanelOpen(false)}
            onOpenFile={onOpenFile}
            log={liveLog}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectMenu — dropdown shown when the title-bar project switcher is clicked.
//
// Sources its rows from the workspace store's recents list. Adds an explicit
// "Open Folder…" entry so this is the one menu the operator needs to reach
// for to swap projects.
//
// The empty state — no recents yet — collapses to just the Open Folder
// entry plus the "Open Projects hub" footer. No fake `acme/*` rows.
// ---------------------------------------------------------------------------

interface ProjectMenuProps {
  onPick: (id: string) => void
  onClose: () => void
  onHub: () => void
  onNewProject: () => void
}

function ProjectMenu({ onPick, onClose, onHub, onNewProject }: ProjectMenuProps) {
  const recents = useWorkspaceStore((s) => s.recents)
  const currentId = useWorkspaceStore((s) => s.project?.id ?? null)
  const addRepoToProject = useWorkspaceStore((s) => s.addRepoToProject)
  const hasProject = useWorkspaceStore((s) => s.project !== null)

  return (
    <>
      <div
        // Invisible scrim that closes the menu on any outside click.
        style={{ position: 'fixed', inset: 0, zIndex: 80 }}
        onClick={onClose}
      />
      <div className="menu">
        <div className="menu-head">Switch project</div>

        <div
          className="menu-item menu-item-cta"
          onClick={onNewProject}
          role="button"
          tabIndex={0}
        >
          <Icon name="plus" size={14} />
          <div className="mi-meta">
            <div className="mi-n">New Project</div>
            <div className="mi-s">Create an empty project and add folders</div>
          </div>
          <span className="kbd">⌘⇧N</span>
        </div>

        {hasProject && (
          <div
            className="menu-item menu-item-cta"
            onClick={async () => {
              onClose()
              try {
                const result = await window.hive.project.openDialog()
                if (result.canceled || !result.path) return
                await addRepoToProject(result.path)
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Add Folder failed', err)
              }
            }}
            role="button"
            tabIndex={0}
          >
            <Icon name="folder-plus" size={14} />
            <div className="mi-meta">
              <div className="mi-n">Add Folder…</div>
              <div className="mi-s">Pick a folder to add to the current project</div>
            </div>
          </div>
        )}

        {recents.length === 0 ? (
          <div className="menu-empty">No recent projects yet.</div>
        ) : (
          recents.map((r: RecentEntry) => (
            <div
              key={r.id}
              className={'menu-item' + (r.id === currentId ? ' cur' : '')}
              onClick={() => onPick(r.id)}
              role="button"
              tabIndex={0}
            >
              <span
                className="proj-dot"
                style={{ background: 'var(--fg-3)', width: 8, height: 8 }}
              />
              <div className="mi-meta">
                <div className="mi-n">{r.name}</div>
                <div className="mi-s">
                  {r.repoCount} repo{r.repoCount === 1 ? '' : 's'} ·{' '}
                  {formatRelativeTime(r.lastOpenedAt)}
                </div>
              </div>
            </div>
          ))
        )}

        <div className="menu-foot">
          <button
            className="menu-foot-btn"
            type="button"
            onClick={onHub}
          >
            <Icon name="layout-grid" size={14} />
            Open Projects hub
          </button>
        </div>
      </div>
    </>
  )
}
