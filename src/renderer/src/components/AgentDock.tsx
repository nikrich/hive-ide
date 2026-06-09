/**
 * Hive IDE — right-side agent orchestration dock.
 *
 * Three tabs over the active run:
 *   - Run:     KV summary of the run + team roster
 *   - Stories: mini-board (In progress / In review / Pending / Done)
 *   - Chat:    live file-backed chat with the manager (`.hive/chat.ndjson`)
 *
 * Owns `AgentDock.tsx` exclusively. Reads live hive-derived data via props
 * (adapted in `lib/hiveView`) so the component stays a pure renderer.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Btn,
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
import type { HiveConnection } from '../../../types/hive'
import { useHiveRun } from '../lib/useHiveRun'
import type { HiveRunState } from '../lib/useHiveRun'
import { useHiveLoop } from '../lib/useHiveLoop'
import { useManagerStatus } from '../lib/useManagerStatus'
import type { IndexStatus } from '../../../types/hive'
import { useWorkspaceStore } from '../store/workspaceStore'
import { NewStoryModal } from './NewStoryModal'
import { NewRequirementModal } from './NewRequirementModal'
import type { RequirementCard } from '../lib/hiveView'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenFile = (path: string) => void

export interface DockProps {
  onOpenFile: OpenFile
  board: Board
  needsInput: Story[]
  requirements: RequirementCard[]
  roster: Agent[]
  chat: ChatMsg[]
  onSendChat: (text: string) => void
  hiveConnection: HiveConnection
  onConnectHive: () => void
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

/**
 * The slice 2a run control surface threaded down to each story card: the live
 * run (if any) plus start/stop, and whether the dock is gated to a connected
 * hive workspace.
 */
interface RunControl {
  active: HiveRunState['active']
  connected: boolean
  start: (storyId: string) => Promise<void>
  stop: () => Promise<void>
}

interface MiniBoardProps {
  board: Board
  onOpenFile: OpenFile
  run: RunControl
}

function MiniBoard({ board, onOpenFile, run }: MiniBoardProps) {
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
              <StoryCard key={s.id} story={s} onOpenFile={onOpenFile} run={run} />
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
  run: RunControl
}

function StoryCard({ story, onOpenFile, run }: StoryCardProps) {
  const live: StoryStatus = 'running'
  const className = 'scard' + (story.status === live ? ' live' : '')
  const isRunning = run.active !== null && run.active.storyId === story.id
  return (
    <div
      className={className}
      onClick={() => {
        if (story.file) onOpenFile(story.file)
      }}
    >
      <div className="st">
        <span className="sid">{story.id}</span>
        {story.pts > 0 && <span className="pts">{story.pts} pts</span>}
        {run.connected &&
          (isRunning ? (
            <Btn
              kind="amber"
              sm
              icon="square"
              style={{ marginLeft: 'auto' }}
              onClick={(e) => {
                e.stopPropagation()
                void run.stop()
              }}
            >
              Stop
            </Btn>
          ) : (
            <Btn
              kind="outline"
              sm
              icon="play"
              style={{ marginLeft: 'auto' }}
              disabled={run.active !== null}
              onClick={(e) => {
                e.stopPropagation()
                void run.start(story.id)
              }}
            >
              Run
            </Btn>
          ))}
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
// Repo index status (slice 2b-2a)
// ---------------------------------------------------------------------------

const INDEX_LABEL: Record<IndexStatus, string> = {
  indexed: 'indexed ✓',
  indexing: 'indexing…',
  failed: 'failed',
  unindexed: 'not indexed',
}

interface IndexPanelProps {
  repos: { name: string }[]
  status: Record<string, IndexStatus>
  reindex: (repo: string) => void
}

function IndexPanel({ repos, status, reindex }: IndexPanelProps) {
  if (repos.length === 0) return null
  return (
    <div className="idx-panel">
      <div className="idx-head">Repo index <span className="ct">{repos.length}</span></div>
      {repos.map((r) => {
        const s: IndexStatus = status[r.name] ?? 'unindexed'
        return (
          <div className="idx-row" key={r.name}>
            <span className="idx-name">{r.name}</span>
            <span className={`idx-state idx-state--${s}`}>{INDEX_LABEL[s]}</span>
            <button
              type="button"
              className="idx-reindex"
              title="Re-index"
              disabled={s === 'indexing'}
              onClick={() => reindex(r.name)}
            >
              ↻
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Run panel
// ---------------------------------------------------------------------------

interface RunPanelProps {
  roster: Agent[]
  onOpenFile: OpenFile
  connected: boolean
  needsInput: Story[]
  loop: ReturnType<typeof useHiveLoop>
  manager: ReturnType<typeof useManagerStatus>
  repos: { name: string }[]
}

function RunPanel({ roster, onOpenFile, connected, needsInput, loop, manager, repos }: RunPanelProps) {
  return (
    <>
      {connected && (
        <div className="loop-bar">
          {loop.status.running ? (
            <Btn kind="amber" sm icon="square" onClick={() => void loop.stop()}>Stop loop</Btn>
          ) : (
            <Btn kind="cta" sm icon="play" onClick={() => void loop.start()}>Start loop</Btn>
          )}
          <span className="loop-status">
            {loop.status.running
              ? (loop.status.currentStory ? `Working on ${loop.status.currentStory}` : 'Idle — waiting for stories')
              : 'Stopped'}
          </span>
        </div>
      )}
      {connected && (
        <IndexPanel repos={repos} status={manager.status} reindex={(r) => void manager.reindex(r)} />
      )}
      {connected && needsInput.length > 0 && (
        <div className="needs-input">
          <div className="ni-head">Needs input <span className="ct">{needsInput.length}</span></div>
          {needsInput.map((s) => (
            <NeedsInputCard
              key={s.id}
              story={s}
              question={loop.questions[s.id] ?? ''}
              onAnswer={(text) => void loop.answer(s.id, text)}
            />
          ))}
        </div>
      )}
      {!connected && (
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
      )}
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
// Needs-input answer card
// ---------------------------------------------------------------------------

interface NeedsInputCardProps {
  story: Story
  question: string
  onAnswer: (text: string) => void
}

function NeedsInputCard({ story, question, onAnswer }: NeedsInputCardProps) {
  const [text, setText] = useState('')
  return (
    <div className="ni-card">
      <div className="ni-sid">{story.id}</div>
      <div className="ni-title">{story.title}</div>
      {question && <div className="ni-q">{question}</div>}
      <textarea
        className="ns-input ns-textarea"
        aria-label={`Answer for ${story.id}`}
        rows={3}
        placeholder="Type your answer…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="ni-actions">
        <Btn kind="cta" sm icon="send" disabled={text.trim() === ''} onClick={() => { onAnswer(text.trim()); setText('') }}>
          Send answer
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  chat: ChatMsg[]
  onSend: (text: string) => void
}

function ChatPanel({ chat, onSend }: ChatPanelProps) {
  const [text, setText] = useState<string>('')
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (endRef.current) endRef.current.scrollTop = endRef.current.scrollHeight
  }, [chat])

  function send(): void {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className="chat">
      <div className="chat-scroll" ref={endRef}>
        {chat.length === 0 && (
          <div className="chat-empty">No messages yet — talk to the manager below.</div>
        )}
        {chat.map((m, i) => (
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
// Requirement cards (slice 2b-2b)
// ---------------------------------------------------------------------------

function RequirementsSection({ requirements }: { requirements: RequirementCard[] }) {
  return (
    <div className="dock-sec req-sec">
      <h4>Requirements <span className="ct">{requirements.length}</span></h4>
      {requirements.map((r) => (
        <RequirementCardView key={r.id} req={r} />
      ))}
    </div>
  )
}

function RequirementCardView({ req }: { req: RequirementCard }) {
  const approve = (): void => { void window.hive?.requirement?.approve(req.id) }
  const discard = (): void => { void window.hive?.requirement?.discard(req.id) }
  return (
    <div className="req-card">
      <div className="req-head">
        <span className="req-id">{req.id}</span>
        <span className={`req-pill req-pill--${req.status}`}>
          {req.status === 'decomposing' && <Pulse />}
          {req.status}
        </span>
      </div>
      <div className="req-title">{req.title}</div>
      {req.status === 'decomposed' && (
        <>
          <div className="req-proposed">
            {req.proposed.map((p) => (
              <div key={p.id} className="req-pstory">
                <RoleAva role={p.role} size={18} />
                <span className="req-pstory-title">{p.title}</span>
                <span className={'req-repo' + (p.unknownRepo ? ' req-repo--warn' : '')}>
                  {p.unknownRepo && <Icon name="alert-triangle" size={12} />}
                  {p.team || '(unrouted)'}
                </span>
              </div>
            ))}
            {req.proposed.length === 0 && (
              <div className="req-empty">No stories proposed.</div>
            )}
          </div>
          <div className="req-actions">
            <Btn kind="cta" sm icon="check" onClick={approve}>Approve plan</Btn>
            <Btn kind="ghost" sm icon="x" onClick={discard}>Discard</Btn>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dock (default export)
// ---------------------------------------------------------------------------

export function Dock({ onOpenFile, board, needsInput, requirements, roster, chat, onSendChat, hiveConnection, onConnectHive }: DockProps) {
  const [tab, setTab] = useState<TabKey>('run')
  const project = useWorkspaceStore((s) => s.project)
  const setHiveWorkspacePath = useWorkspaceStore((s) => s.setHiveWorkspacePath)
  const [showNewStory, setShowNewStory] = useState(false)
  const [showNewReq, setShowNewReq] = useState(false)
  const run = useHiveRun()
  const loop = useHiveLoop()
  const manager = useManagerStatus()
  const repos = useWorkspaceStore((s) => s.repos)
  const runControl: RunControl = {
    active: run.active,
    connected: hiveConnection.state === 'connected',
    start: run.start,
    stop: run.stop,
  }
  return (
    <aside className="dock">
      {hiveConnection.state === 'no-workspace' && (
        <div className="hive-banner">
          No hive workspace connected.{' '}
          <button type="button" className="hive-connect-btn" onClick={onConnectHive}>
            Connect…
          </button>
          <button
            type="button"
            className="hive-connect-btn"
            disabled={project === null}
            onClick={async () => {
              if (!project) return
              try {
                const { workspacePath } = await window.hive.workspace.ensure(project.id)
                setHiveWorkspacePath(workspacePath)
                await window.hive.orchestration.setWorkspace(workspacePath)
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('initialize hive failed', err)
              }
            }}
          >
            Initialize hive
          </button>
        </div>
      )}
      {hiveConnection.state === 'not-found' && (
        <div className="hive-banner">
          Workspace not found: {hiveConnection.path}.{' '}
          <button type="button" className="hive-connect-btn" onClick={onConnectHive}>
            Reconnect…
          </button>
        </div>
      )}
      {hiveConnection.state === 'connected' && (
        <div className="hive-banner hive-banner--ok">
          Connected · {hiveConnection.path}
        </div>
      )}
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
        {tab === 'run' && (
          <RunPanel
            roster={roster}
            onOpenFile={onOpenFile}
            connected={hiveConnection.state === 'connected'}
            needsInput={needsInput}
            loop={loop}
            manager={manager}
            repos={repos}
          />
        )}
        {tab === 'board' && (
          <>
            {hiveConnection.state === 'connected' && (
              <div style={{ padding: '8px 12px', display: 'flex', gap: 8 }}>
                <Btn kind="outline" sm icon="plus" onClick={() => setShowNewStory(true)}>
                  New story
                </Btn>
                <Btn kind="outline" sm icon="plus" onClick={() => setShowNewReq(true)}>
                  New requirement
                </Btn>
              </div>
            )}
            {hiveConnection.state === 'connected' && requirements.length > 0 && (
              <RequirementsSection requirements={requirements} />
            )}
            <MiniBoard board={board} onOpenFile={onOpenFile} run={runControl} />
          </>
        )}
        {tab === 'chat' && <ChatPanel chat={chat} onSend={onSendChat} />}
      </div>
      {showNewStory && project && hiveConnection.state === 'connected' && (
        <NewStoryModal
          onClose={() => setShowNewStory(false)}
          onCreate={async (fields) => {
            setShowNewStory(false)
            try {
              await window.hive.story.create(hiveConnection.path, fields)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('create story failed', err)
            }
          }}
        />
      )}
      {showNewReq && project && hiveConnection.state === 'connected' && (
        <NewRequirementModal
          onClose={() => setShowNewReq(false)}
          onCreate={async (fields) => {
            setShowNewReq(false)
            try {
              await window.hive?.requirement?.create(fields)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('create requirement failed', err)
            }
          }}
        />
      )}
    </aside>
  )
}

export default Dock
