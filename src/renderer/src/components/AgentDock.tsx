/**
 * Hive IDE — right-side agent orchestration dock.
 *
 * Three tabs over the active run:
 *   - Run:     KV summary of the run + team roster
 *   - Stories: mini-board (In progress / In review / Pending / Done)
 *   - Chat:    inline chat with the manager (simulated reply after ~700 ms)
 *
 * Owns `AgentDock.tsx` exclusively. Reads seed data via props so the component
 * stays a pure renderer.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Icon,
  Pulse,
  RoleAva,
  StatusChip,
  type StatusKey,
} from './primitives'
import {
  ROLE,
  type Agent,
  type AgentStatus,
  type Board,
  type ChatMsg,
  type RoleKey,
  type Story,
  type StoryStatus,
} from '../data/seed'
import { MockDataRibbon } from './MockDataRibbon'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenFile = (path: string) => void

export interface DockProps {
  onOpenFile: OpenFile
  board: Board
  roster: Agent[]
  chat: ChatMsg[]
}

type TabKey = 'run' | 'board' | 'chat'

const TABS: ReadonlyArray<readonly [TabKey, string]> = [
  ['run', 'Run'],
  ['board', 'Stories'],
  ['chat', 'Chat'],
] as const

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface KVProps {
  k: string
  v: ReactNode
  mono?: boolean
}

function KV({ k, v, mono }: KVProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '7px 0',
        borderBottom: '1px solid var(--border-subtle)',
        font: 'var(--t-body-sm)',
      }}
    >
      <span style={{ color: 'var(--fg-3)' }}>{k}</span>
      <span
        style={{
          color: 'var(--fg-1)',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          fontSize: mono ? 12 : undefined,
          whiteSpace: 'nowrap',
        }}
      >
        {v}
      </span>
    </div>
  )
}

/** Agent statuses are a subset of the chip's `StatusKey` — narrow safely. */
function asStatusKey(s: AgentStatus): StatusKey {
  return s
}

// ---------------------------------------------------------------------------
// Roster row
// ---------------------------------------------------------------------------

interface AgentRosterRowProps {
  a: Agent
  onOpenFile: OpenFile
}

function AgentRosterRow({ a, onOpenFile }: AgentRosterRowProps) {
  const r = ROLE[a.role]
  const dot: string | undefined =
    a.status === 'running'
      ? 'var(--status-running)'
      : a.status === 'review'
        ? 'var(--status-review)'
        : undefined

  return (
    <div className="agent-row">
      <RoleAva
        role={a.role}
        size={30}
        live={a.status === 'running'}
        dot={dot}
      />
      <div className="meta">
        <div className="nm">
          {r.label}{' '}
          <span className="model" style={{ fontWeight: 400 }}>
            · {r.model}
          </span>
        </div>
        <div className="note">
          {a.file ? (
            <span
              style={{ cursor: 'pointer', color: 'var(--accent-text)' }}
              onClick={() => a.file && onOpenFile(a.file)}
            >
              {a.note}
            </span>
          ) : (
            a.note
          )}
        </div>
      </div>
      <StatusChip status={asStatusKey(a.status)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stories mini-board
// ---------------------------------------------------------------------------

interface MiniColDef {
  key: keyof Board
  label: string
}

const MINI_COLS: ReadonlyArray<MiniColDef> = [
  { key: 'running', label: 'In progress' },
  { key: 'review', label: 'In review' },
  { key: 'pending', label: 'Pending' },
  { key: 'done', label: 'Done' },
]

interface MiniBoardProps {
  board: Board
  onOpenFile: OpenFile
}

function MiniBoard({ board, onOpenFile }: MiniBoardProps) {
  return (
    <div className="dock-sec">
      {MINI_COLS.map((col) => {
        const items: Story[] = board[col.key]
        return (
          <div className="mini-col" key={col.key}>
            <div className="ch">
              {col.key === 'running' && <Pulse />}
              {col.label} <span className="ct">{items.length}</span>
            </div>
            {items.map((s) => (
              <StoryCard key={s.id} story={s} onOpenFile={onOpenFile} />
            ))}
            {items.length === 0 && (
              <div
                style={{
                  font: 'var(--t-body-sm)',
                  color: 'var(--fg-3)',
                  padding: '2px 2px 6px',
                }}
              >
                —
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface StoryCardProps {
  story: Story
  onOpenFile: OpenFile
}

function StoryCard({ story, onOpenFile }: StoryCardProps) {
  const live: StoryStatus = 'running'
  const className = 'scard' + (story.status === live ? ' live' : '')
  return (
    <div
      className={className}
      onClick={() => {
        if (story.file) onOpenFile(story.file)
      }}
    >
      <div className="st">
        <span className="sid">{story.id}</span>
        <span className="pts">{story.pts} pts</span>
      </div>
      <div className="stt">{story.title}</div>
      <div className="sf">
        <RoleAva role={story.role} size={20} />
        <span style={{ font: 'var(--t-meta)', color: 'var(--fg-3)' }}>
          {ROLE[story.role].label}
        </span>
        {story.file && (
          <span
            style={{
              marginLeft: 'auto',
              font: 'var(--t-code-sm)',
              color: 'var(--accent-text)',
            }}
          >
            {story.file.split('/').pop()}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Run panel
// ---------------------------------------------------------------------------

interface RunPanelProps {
  roster: Agent[]
  onOpenFile: OpenFile
}

function RunPanel({ roster, onOpenFile }: RunPanelProps) {
  return (
    <>
      <div className="dock-sec">
        <h4>
          Active run <span className="ct">REQ-001</span>
        </h4>
        <div
          style={{
            font: '600 13.5px/1.4 var(--font-ui)',
            color: 'var(--fg-1)',
            marginBottom: 12,
          }}
        >
          OAuth2 with Google &amp; GitHub providers
        </div>
        <KV k="Status" v={<StatusChip status="running" />} />
        <KV k="Branch" v="feat/oauth2" mono />
        <KV k="Worktrees" v="3 active" mono />
        <KV k="Manager tick" v="184" mono />
        <KV k="Story points" v="14 / 31 done" mono />
      </div>
      <div className="dock-sec">
        <h4>
          Team roster <span className="ct">{roster.length}</span>
        </h4>
        {roster.map((a, i) => (
          <AgentRosterRow key={`${a.role}-${i}`} a={a} onOpenFile={onOpenFile} />
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

const MANAGER_REPLY: string =
  "Understood — I'll fold that into the current run and re-pend the affected stories. The team will pick it up on the next tick."

/** Delay before the simulated manager reply lands in the chat scroll, in ms. */
const MANAGER_REPLY_DELAY_MS = 700

interface ChatPanelProps {
  chat: ChatMsg[]
}

function ChatPanel({ chat }: ChatPanelProps) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(chat)
  const [text, setText] = useState<string>('')
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (endRef.current) endRef.current.scrollTop = endRef.current.scrollHeight
  }, [msgs])

  function send(): void {
    const t = text.trim()
    if (!t) return
    setMsgs((m) => [...m, { who: 'you', txt: t }])
    setText('')
    const reply: ChatMsg = { who: 'manager', role: 'manager', txt: MANAGER_REPLY }
    setTimeout(() => {
      setMsgs((m) => [...m, reply])
    }, MANAGER_REPLY_DELAY_MS)
  }

  return (
    <div className="chat">
      <div className="chat-scroll" ref={endRef}>
        {msgs.map((m, i) => (
          <ChatBubble key={i} msg={m} />
        ))}
      </div>
      <div className="chat-in">
        <input
          value={text}
          placeholder="Message the orchestrator…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button className="ib-btn" onClick={send} aria-label="Send message">
          <Icon name="send-horizontal" size={16} />
        </button>
      </div>
    </div>
  )
}

function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isManager = msg.who === 'manager'
  // The design reference shows an inline `<b>Manager</b>` prefix on manager
  // bubbles; we render it as real JSX rather than dangerouslySetInnerHTML.
  return (
    <div className={`msg ${msg.who}`}>
      {isManager && <RoleAva role="manager" size={26} />}
      <div className="bub">
        {isManager ? (
          <>
            <b>Manager</b> · {msg.txt}
          </>
        ) : (
          msg.txt
        )}
      </div>
    </div>
  )
}

// Re-export role key for downstream consumers that compose against the dock.
export type { RoleKey }

// ---------------------------------------------------------------------------
// Dock (default export)
// ---------------------------------------------------------------------------

export function Dock({ onOpenFile, board, roster, chat }: DockProps) {
  const [tab, setTab] = useState<TabKey>('run')
  return (
    <aside className="dock">
      <MockDataRibbon />
      <div className="dock-tabs">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            className={'dock-tab' + (tab === k ? ' active' : '')}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="dock-body">
        {tab === 'run' && <RunPanel roster={roster} onOpenFile={onOpenFile} />}
        {tab === 'board' && <MiniBoard board={board} onOpenFile={onOpenFile} />}
        {tab === 'chat' && <ChatPanel chat={chat} />}
      </div>
    </aside>
  )
}

export default Dock
