/**
 * Hive IDE — file explorer (recursive tree).
 *
 * Strongly-typed port of `design-reference/explorer.jsx`. Markup intentionally
 * mirrors the prototype's `.explorer / .exp-head / .exp-actions / .exp-repo /
 * .tree / .row` classes so the existing CSS in `styles/ide.css` applies
 * verbatim.
 *
 * Single-file by design: all helpers (TreeNode row, openSet seeding) live
 * here so the story owns exactly `Explorer.tsx`.
 */

import { useState } from 'react'
import { Icon, fileIcon } from './primitives'
import { ROLE } from '../data/seed'
import type { Project, RoleKey, TreeNode } from '../data/seed'

export interface ExplorerProps {
  /** Opens a file in the editor. Called with the node's `path`. */
  openFile: (path: string) => void
  /** Path of the currently-focused file; row is highlighted with `.sel`. */
  activePath: string | null
  /** Active project — used for the repo/branch line under the header. */
  project: Project
  /** Root file tree to render. */
  tree: TreeNode[]
}

/**
 * Unique key for a folder in the open-set. Folders are identified by their
 * name + depth + optional path so repeated folder names at different depths
 * don't collide.
 */
function folderKey(node: TreeNode, depth: number): string {
  return node.name + depth + (node.path ?? '')
}

/** Walk the tree and seed the open-set with every folder that has `open: true`. */
function seedOpenSet(nodes: TreeNode[], depth = 0, acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'folder') {
      if (n.open) acc.add(folderKey(n, depth))
      if (n.children) seedOpenSet(n.children, depth + 1, acc)
    }
  }
  return acc
}

interface TreeRowProps {
  node: TreeNode
  depth: number
  openSet: Set<string>
  toggle: (key: string) => void
  openFile: (path: string) => void
  activePath: string | null
}

function TreeRow({ node, depth, openSet, toggle, openFile, activePath }: TreeRowProps) {
  const pad = 6 + depth * 13

  if (node.type === 'folder') {
    const key = folderKey(node, depth)
    const isOpen = openSet.has(key)
    return (
      <div>
        <div className="row" style={{ paddingLeft: pad }} onClick={() => toggle(key)}>
          <span className="tw">
            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
          </span>
          <span className="fi ic-folder">
            <Icon name={isOpen ? 'folder-open' : 'folder'} size={15} />
          </span>
          <span className="nm">{node.name}</span>
        </div>
        {isOpen &&
          node.children?.map((child, i) => (
            <TreeRow
              key={folderKey(child, depth + 1) + (child.path ?? '') + i}
              node={child}
              depth={depth + 1}
              openSet={openSet}
              toggle={toggle}
              openFile={openFile}
              activePath={activePath}
            />
          ))}
      </div>
    )
  }

  const [iconName, tint] = fileIcon(node.name)
  const role: RoleKey | undefined = node.agent
  const roleMeta = role ? ROLE[role] : null

  return (
    <div
      className={'row' + (node.path && activePath === node.path ? ' sel' : '')}
      style={{ paddingLeft: pad + 14 }}
      onClick={() => node.path && openFile(node.path)}
    >
      <span className={'fi ' + tint}>
        <Icon name={iconName} size={15} />
      </span>
      <span
        className="nm"
        style={{ color: node.git === 'U' ? 'var(--teal-400)' : undefined }}
      >
        {node.name}
      </span>
      {roleMeta && (
        <span
          className="agent-dot"
          title={`${roleMeta.label} is editing`}
          style={{ background: roleMeta.color }}
        />
      )}
      {node.git && <span className={'git git-' + node.git}>{node.git}</span>}
    </div>
  )
}

export function Explorer({ openFile, activePath, project, tree }: ExplorerProps) {
  const [openSet, setOpenSet] = useState<Set<string>>(() => seedOpenSet(tree))

  const toggle = (key: string) =>
    setOpenSet((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // project.name is `org/repo` — show just the repo half, like the prototype.
  const repoName = project.name.includes('/') ? project.name.split('/')[1] : project.name

  return (
    <aside className="explorer">
      <div className="exp-head">
        <span className="ttl">Explorer</span>
        <div className="exp-actions">
          <button className="ib" title="New file" type="button">
            <Icon name="file-plus" />
          </button>
          <button className="ib" title="New folder" type="button">
            <Icon name="folder-plus" />
          </button>
          <button className="ib" title="Refresh" type="button">
            <Icon name="refresh-cw" />
          </button>
          <button
            className="ib"
            title="Collapse all"
            type="button"
            onClick={() => setOpenSet(new Set())}
          >
            <Icon name="chevrons-down-up" />
          </button>
        </div>
      </div>
      <div className="exp-repo">
        <Icon name="git-branch" size={14} /> {repoName}
        <span
          style={{
            marginLeft: 'auto',
            font: 'var(--t-code-sm)',
            color: 'var(--fg-3)',
          }}
        >
          {project.branch}
        </span>
      </div>
      <div className="tree">
        {tree.map((n, i) => (
          <TreeRow
            key={folderKey(n, 0) + i}
            node={n}
            depth={0}
            openSet={openSet}
            toggle={toggle}
            openFile={openFile}
            activePath={activePath}
          />
        ))}
      </div>
    </aside>
  )
}
