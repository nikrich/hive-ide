/**
 * Hive IDE — shared "Open Folder…" flow.
 *
 * Two callers — the Welcome / Projects hub button and the title-bar
 * project-switcher dropdown — both need the same sequence:
 *
 *   1. ask the main process to show the native folder picker,
 *   2. run project detection on the chosen path,
 *   3. tell the workspace store about the new project,
 *   4. record it in the recents list.
 *
 * Centralising the sequence here keeps the renderer components free of
 * IPC details and gives us one obvious place to unit-test the wiring.
 *
 * The store is imported lazily — by reading via `getState()` instead of a
 * hook — so this module stays plain TypeScript and can run under vitest
 * without a React tree.
 */

import { useWorkspaceStore } from '../store/workspaceStore'

/**
 * Drive the Open Folder workflow end-to-end.
 *
 * Returns the freshly-opened project's id on success, or `null` if the
 * user cancelled the dialog. Errors from `openDialog` / `detect` propagate
 * to the caller — the UI layer decides whether to swallow or surface them.
 */
export async function openFolderFlow(): Promise<string | null> {
  const dialog = await window.hive.project.openDialog()
  if (dialog.canceled || !dialog.path) return null

  const project = await window.hive.project.detect(dialog.path)
  const store = useWorkspaceStore.getState()

  store.setProject(project)
  store.pushRecent({
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    source: project.source,
    repoCount: project.repos.length,
    lastOpenedAt: Date.now(),
  })

  return project.id
}
