/**
 * Hive IDE — tabbed editor group.
 *
 * Owns the centre column of the IDE: a horizontal tab strip, a breadcrumb,
 * and either a writable `CodeEditor`, a read-only streaming `AgentEditor`, or
 * an `EmptyEditor` placeholder. Mirrors `design-reference/editor.jsx` but is
 * fully typed and self-contained — it does *not* reach into the file tree;
 * `lang` is derived from the filename extension instead.
 *
 * Public API (acceptance criteria for STORY-008):
 *   <EditorGroup
 *     tabs={…}              // open tab paths
 *     active={…}            // currently focused path, or null
 *     dirty={…}             // path → has-unsaved-changes
 *     contents={…}          // path → current text contents
 *     agentFile={…}         // path being streamed by an agent, or null
 *     agentBaseLen={…}      // length of the already-committed prefix
 *     onSelect={…}          // (path) => void
 *     onClose={…}           // (path) => void
 *     onChange={…}          // (path, value) => void
 *   />
 *
 * Two extra optional props (`agentRole`, `agentBranch`) carry information
 * the design-reference hard-coded; defaults match the reference so callers
 * can adopt incrementally without breaking visual parity.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { highlightCode } from '../lib/highlight'
import { Icon, RoleAva, fileIcon } from './primitives'
import { ROLE, type RoleKey } from '../data/seed'

// ---------------------------------------------------------------------------
// Layout constants — must stay in sync with `.code-highlight` padding-top and
// the computed line-height of `var(--t-code)` in ide.css. Changing either side
// in isolation will misalign the current-line glow.
// ---------------------------------------------------------------------------
const PAD_TOP = 14
const LINE_HEIGHT = 20.8

// ---------------------------------------------------------------------------
// Language inference. The design-reference looked `lang` up on the file-tree
// node; we don't have tree access from inside the editor (and shouldn't),
// so we lean on the extension. Anything unknown falls through to "ts", which
// the highlighter treats as the generic c-like tokenizer.
// ---------------------------------------------------------------------------
const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'tsx',
  json: 'json',
  css: 'css',
  md: 'md',
  html: 'tsx',
  xml: 'tsx',
  svg: 'tsx',
}

function langFromPath(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase()
  return LANG_BY_EXT[ext] ?? 'ts'
}

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

export interface TabBarProps {
  tabs: readonly string[]
  active: string | null
  dirty: Readonly<Record<string, boolean>>
  agentFile: string | null
  agentRole: RoleKey
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

function TabBar({
  tabs,
  active,
  dirty,
  agentFile,
  agentRole,
  onSelect,
  onClose,
}: TabBarProps) {
  return (
    <div className="tabbar">
      {tabs.map((path) => {
        const name = path.split('/').pop() ?? path
        const [iconName, tint] = fileIcon(name)
        const isAgent = path === agentFile
        const isDirty = Boolean(dirty[path])
        const isActive = path === active

        const closeHandler = (event: MouseEvent<HTMLSpanElement>) => {
          event.stopPropagation()
          onClose(path)
        }

        return (
          <div
            key={path}
            className={'tab' + (isActive ? ' active' : '')}
            onClick={() => onSelect(path)}
            title={path}
          >
            <span className={'fi ' + tint}>
              <Icon name={iconName} size={14} />
            </span>
            <span className="tnm">{name}</span>
            {isAgent && (
              <span
                className="agent-dot"
                style={{ background: ROLE[agentRole].color }}
                title={`${ROLE[agentRole].label} is editing this file`}
              />
            )}
            {isDirty ? (
              <span
                className="dirty"
                onClick={closeHandler}
                title="Unsaved changes — click to close"
              />
            ) : (
              <span
                className="x"
                onClick={closeHandler}
                title="Close tab"
              >
                <Icon name="x" size={13} />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

export interface BreadcrumbProps {
  path: string
  dirty?: boolean
}

function Breadcrumb({ path, dirty }: BreadcrumbProps) {
  const segs = path.split('/')
  return (
    <div className="breadcrumb">
      <Icon name="folder" size={13} />
      {segs.map((seg, i) => (
        // eslint-disable-next-line react/no-array-index-key -- segments are positional
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {i > 0 && <Icon name="chevron-right" size={13} />}
          <span className={'seg' + (i === segs.length - 1 ? ' last' : '')}>{seg}</span>
        </span>
      ))}
      {dirty && (
        <span style={{ marginLeft: 8, color: 'var(--fg-3)', font: 'var(--t-meta)' }}>
          ● unsaved
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CodeEditor — writable surface. Transparent <textarea> stacked over a
// live-highlighted <pre>; gutter on the left, current-line glow tracking
// the caret. Tab inserts two spaces (no indentation level inference here —
// the agent or the operator decides).
// ---------------------------------------------------------------------------

export interface CodeEditorProps {
  path: string
  lang: string
  value: string
  onChange: (value: string) => void
}

function CodeEditor({ path, lang, value, onChange }: CodeEditorProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [curLine, setCurLine] = useState(0)

  // Recompute on every change. Cheap for the sizes this editor targets;
  // the highlighter is a single-pass scanner with no DOM access.
  const lines = value.split('\n')
  const html = highlightCode(value, lang)

  function syncCaret() {
    const ta = taRef.current
    if (!ta) return
    const upto = ta.value.slice(0, ta.selectionStart)
    setCurLine(upto.split('\n').length - 1)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const ta = event.currentTarget
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = value.slice(0, start) + '  ' + value.slice(end)
    onChange(next)
    // Re-place caret two characters forward once React has flushed the new value.
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.selectionStart = el.selectionEnd = start + 2
    })
  }

  return (
    <div className="code-scroll" data-path={path}>
      <div className="code-inner">
        <div className="gutter">
          {lines.map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key -- line numbers are positional
            <div key={i} className={'gl' + (i === curLine ? ' cur' : '')}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="code-cell">
          <div
            className="lineglow"
            style={{ top: PAD_TOP + curLine * LINE_HEIGHT }}
          />
          <pre
            className="code-highlight"
            aria-hidden="true"
            // highlightCode escapes its input before wrapping in spans — safe to inject.
            dangerouslySetInnerHTML={{ __html: html + '\n' }}
          />
          <textarea
            ref={taRef}
            className="code-input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onKeyDown={onKeyDown}
            onSelect={syncCaret}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AgentEditor — read-only streaming view. Renders the committed prefix
// (regular highlight) followed by the agent's freshly-added suffix
// (highlight + diff-add background wash) and a blinking ghost caret. The
// container auto-scrolls to the caret on every value update.
// ---------------------------------------------------------------------------

export interface AgentEditorProps {
  path: string
  lang: string
  /** Length of the already-committed prefix of `value`. */
  baseLen: number
  value: string
  role: RoleKey
  /** Optional branch label displayed in the banner (e.g. `agent/web--im-7c3a`). */
  branch?: string
}

/**
 * CSS custom-property bag for the ghost caret. `--role-c` is read by the
 * `.ghost-caret` rule in ide.css to tint the caret per agent role. React's
 * typings don't allow arbitrary CSS variables on `CSSProperties`, so we
 * widen via an indexer locally rather than reaching for `any`.
 */
type CssVars = CSSProperties & Record<`--${string}`, string>

function AgentEditor({ path, lang, baseLen, value, role, branch }: AgentEditorProps) {
  const r = ROLE[role]
  // Clamp baseLen defensively so a stale prop doesn't break slicing.
  const safeBase = Math.max(0, Math.min(baseLen, value.length))
  const committed = value.slice(0, safeBase)
  const added = value.slice(safeBase)
  const lines = value.split('\n')
  const htmlC = highlightCode(committed, lang)
  const htmlA = highlightCode(added, lang)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [value])

  const preStyle: CssVars = { '--role-c': r.color }
  const caretStyle: CssVars = { '--role-c': r.color }

  return (
    <>
      <div className="agent-banner" data-path={path}>
        <RoleAva role={role} size={22} live />
        <span>
          <span className="who" style={{ color: r.color }}>
            {r.label}
          </span>
          {' is writing this file…'}
        </span>
        <span className="sp" />
        {branch && <span className="meta-mono">{branch}</span>}
        <span className="lock">
          <Icon name="lock" size={13} /> read-only while agent owns it
        </span>
      </div>
      <div className="code-scroll" ref={scrollRef}>
        <div className="code-inner">
          <div className="gutter">
            {lines.map((_, i) => (
              // eslint-disable-next-line react/no-array-index-key -- line numbers are positional
              <div key={i} className="gl">
                {i + 1}
              </div>
            ))}
          </div>
          <div className="code-cell">
            <pre className="code-highlight" style={preStyle}>
              <span dangerouslySetInnerHTML={{ __html: htmlC }} />
              <span
                style={{ background: 'var(--diff-add-bg)' }}
                dangerouslySetInnerHTML={{ __html: htmlA }}
              />
              <span className="ghost-caret" style={caretStyle} />
            </pre>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// EmptyEditor
// ---------------------------------------------------------------------------

function EmptyEditor() {
  return (
    <div className="editor-empty">
      <img src="./hive-mark.png" alt="" />
      <div style={{ font: 'var(--t-h3)', color: 'var(--fg-2)' }}>No file open</div>
      <div className="hint">
        Open a file from the explorer, or press <span className="kbd">⌘K</span> to jump
        anywhere.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EditorGroup — the public composite. The required prop set is exactly the
// one called out in STORY-008's acceptance criteria; `agentRole` and
// `agentBranch` are optional extensions that match the design-reference's
// hard-coded values when omitted.
// ---------------------------------------------------------------------------

export interface EditorGroupProps {
  tabs: readonly string[]
  active: string | null
  dirty: Readonly<Record<string, boolean>>
  contents: Readonly<Record<string, string>>
  agentFile: string | null
  agentBaseLen: number
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onChange: (path: string, value: string) => void
  /** Role of the agent currently streaming `agentFile`. Defaults to `'intermediate'`. */
  agentRole?: RoleKey
  /** Branch / worktree label shown in the agent banner. */
  agentBranch?: string
}

export function EditorGroup({
  tabs,
  active,
  dirty,
  contents,
  agentFile,
  agentBaseLen,
  onSelect,
  onClose,
  onChange,
  agentRole = 'intermediate',
  agentBranch,
}: EditorGroupProps) {
  const path = active
  const lang = path ? langFromPath(path) : 'ts'
  const value = path ? contents[path] ?? '' : ''

  return (
    <section className="editor">
      <TabBar
        tabs={tabs}
        active={active}
        dirty={dirty}
        agentFile={agentFile}
        agentRole={agentRole}
        onSelect={onSelect}
        onClose={onClose}
      />
      {!path && <EmptyEditor />}
      {path && (
        <>
          <Breadcrumb path={path} dirty={Boolean(dirty[path])} />
          {path === agentFile ? (
            <AgentEditor
              path={path}
              lang={lang}
              baseLen={agentBaseLen}
              value={value}
              role={agentRole}
              branch={agentBranch}
            />
          ) : (
            <CodeEditor
              path={path}
              lang={lang}
              value={value}
              onChange={(next) => onChange(path, next)}
            />
          )}
        </>
      )}
    </section>
  )
}

// Named re-exports for tests / future composition. EditorGroup is the only
// component required by the story spec, but exposing the others keeps them
// individually testable without forcing the test to render a full group.
export { TabBar, Breadcrumb, CodeEditor, AgentEditor, EmptyEditor }
