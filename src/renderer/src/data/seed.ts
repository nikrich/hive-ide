/**
 * Hive IDE — demo seed data for the **mocked panels** only.
 *
 * STORY-028 pruned the seed module to its REQ-002 boundary: the editor
 * surface (file tree, file contents, open tabs, agent-streaming demo) is
 * no longer seeded — it runs against real filesystem IPC. What remains
 * is the data driving the panels still frozen behind a mock ribbon:
 *
 *   - **Dock (Run / Stories / Chat)** — `roster`, `board`, `chat`, `ROLE`
 *   - **BottomPanel (manager.log / Problems)** — `log`, `problems`
 *   - **PRsView** — `prs`
 *
 * Each of these gets a real wire-up in its own future REQ.
 *
 * Removed in STORY-028 (REQ-002 spec):
 *   - `FILE_CONTENTS`, `tree`, `openTabs` — Explorer + Editor read from disk.
 *   - `AGENT_FILE`, `AGENT_INCOMING` — agent-streaming demo retired with
 *     the textarea editor.
 *   - `projects` (runtime), `Project`, `ProjectStatus`, `TreeNode`,
 *     `GitStatus` — Welcome shows real recents from `electron-store`; the
 *     workspace types now live in `src/types/workspace.ts`.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Join lines with `\n`. Mirrors the helper in design-reference/data.js. */
const L = (...lines: string[]): string => lines.join('\n')

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type RoleKey =
  | 'manager'
  | 'techlead'
  | 'senior'
  | 'intermediate'
  | 'junior'
  | 'qa'

export interface Role {
  key: RoleKey
  label: string
  abbr: string
  color: string
  model: string
}

export const ROLE: Record<RoleKey, Role> = {
  manager: { key: 'manager', label: 'Manager', abbr: 'MG', color: '#F59E0B', model: 'orchestrator' },
  techlead: { key: 'techlead', label: 'Tech Lead', abbr: 'TL', color: '#8B5CF6', model: 'Claude Opus' },
  senior: { key: 'senior', label: 'Senior', abbr: 'SR', color: '#3B82F6', model: 'Claude Sonnet' },
  intermediate: { key: 'intermediate', label: 'Intermediate', abbr: 'IM', color: '#6366F1', model: 'Claude Haiku' },
  junior: { key: 'junior', label: 'Junior', abbr: 'JR', color: '#22D3EE', model: 'GPT-4o-mini' },
  qa: { key: 'qa', label: 'QA', abbr: 'QA', color: '#10B981', model: 'Claude Sonnet' },
}

// ---------------------------------------------------------------------------
// Orchestration: board, roster, log, chat
// ---------------------------------------------------------------------------

export type StoryStatus = 'pending' | 'running' | 'review' | 'done'

export interface Story {
  id: string
  title: string
  pts: number
  role: RoleKey
  status: StoryStatus
  /** Path of the file this story is actively editing, when applicable. */
  file?: string
}

export interface Board {
  pending: Story[]
  running: Story[]
  review: Story[]
  done: Story[]
}

export const board: Board = {
  pending: [
    { id: 'STORY-007', title: 'Rate-limit the token endpoint', pts: 3, role: 'junior', status: 'pending' },
  ],
  running: [
    { id: 'STORY-002', title: 'Implement Google OAuth flow', pts: 5, role: 'intermediate', status: 'running', file: 'src/lib/oauth.ts' },
    { id: 'STORY-003', title: 'GitHub provider + scopes', pts: 5, role: 'junior', status: 'running' },
  ],
  review: [
    { id: 'STORY-005', title: 'Session cookie + refresh rotation', pts: 6, role: 'senior', status: 'review' },
  ],
  done: [
    { id: 'STORY-001', title: 'OAuth2 provider config scaffold', pts: 3, role: 'junior', status: 'done' },
    { id: 'STORY-004', title: 'useAuth hook + error states', pts: 4, role: 'intermediate', status: 'done' },
    { id: 'STORY-006', title: 'Provider discovery + cache', pts: 5, role: 'senior', status: 'done' },
  ],
}

export type AgentStatus = 'running' | 'done' | 'review' | 'pending'

export interface Agent {
  role: RoleKey
  name: string
  status: AgentStatus
  note: string
  /** Path of the file this agent is currently editing, when applicable. */
  file?: string
}

export const roster: Agent[] = [
  { role: 'manager', name: 'Manager', status: 'running', note: 'draining inbox · tick 184' },
  { role: 'techlead', name: 'Tech Lead', status: 'done', note: 'decomposed 7 stories' },
  { role: 'senior', name: 'Senior', status: 'review', note: 'reviewing STORY-005' },
  { role: 'intermediate', name: 'Intermediate', status: 'running', note: 'writing oauth.ts', file: 'src/lib/oauth.ts' },
  { role: 'junior', name: 'Junior', status: 'running', note: 'STORY-003 · github.ts' },
  { role: 'qa', name: 'QA', status: 'pending', note: 'queued · waiting on STORY-002' },
]

/** Visual class applied to a manager log line in the bottom panel. */
export type LogClass = '' | 'dim' | 'ok' | 'pr'

export interface LogLine {
  t: string
  cls: LogClass
  txt: string
}

export const log: LogLine[] = [
  { t: '00:00', cls: 'dim', txt: 'manager tick 184 — draining inbox (2 messages)' },
  { t: '00:01', cls: '', txt: 'spawned Intermediate → STORY-002 (worktree agent/web--im-7c3a)' },
  { t: '00:04', cls: '', txt: 'Intermediate: editing src/lib/oauth.ts' },
  { t: '00:09', cls: 'ok', txt: '✓ Junior committed src/lib/discovery.ts → STORY-006' },
  { t: '00:12', cls: '', txt: 'Senior requested changes on STORY-005 (refresh rotation)' },
  { t: '00:18', cls: 'pr', txt: 'opened PR #218 — feat(auth): OAuth2 provider config' },
  { t: '00:24', cls: 'ok', txt: '✓ QA passed lint + types on STORY-006' },
]

export interface ChatMsg {
  /** Speaker — either the operator ('you') or one of the role agents. */
  who: 'you' | RoleKey
  /** Role colour pill, when the speaker is an agent. */
  role?: RoleKey
  txt: string
}

export const chat: ChatMsg[] = [
  { who: 'you', txt: 'Make sure refresh tokens rotate on every use.' },
  {
    who: 'manager',
    role: 'manager',
    txt: "Noted. That's STORY-005 (Senior). I've re-pended it with an acceptance note: rotate on use, revoke the old token.",
  },
  {
    who: 'manager',
    role: 'manager',
    txt: "Intermediate is wiring the Google flow in src/lib/oauth.ts now — you'll see it land in the editor live.",
  },
]

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export type Severity = 'warn' | 'info'

export interface Problem {
  sev: Severity
  file: string
  line: number
  msg: string
}

export const problems: Problem[] = [
  { sev: 'warn', file: 'src/hooks/useAuth.ts', line: 18, msg: "'loading' is declared but never read in this scope." },
  { sev: 'info', file: 'src/lib/oauth.ts', line: 27, msg: 'Agent edit in progress — types will re-check on save.' },
]

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export type PrStatus = 'review' | 'merged'
export type ChecksStatus = 'running' | 'passed'

export interface PullRequest {
  num: number
  title: string
  role: RoleKey
  branch: string
  status: PrStatus
  add: number
  del: number
  checks: ChecksStatus
  time: string
}

export const prs: PullRequest[] = [
  {
    num: 218,
    title: 'feat(auth): OAuth2 provider config + Google flow',
    role: 'intermediate',
    branch: 'agent/web--im-7c3a',
    status: 'review',
    add: 137,
    del: 18,
    checks: 'running',
    time: '12m ago',
  },
  {
    num: 217,
    title: 'feat(auth): useAuth hook + provider discovery',
    role: 'senior',
    branch: 'agent/web--sr-2f10',
    status: 'merged',
    add: 98,
    del: 22,
    checks: 'passed',
    time: '1h ago',
  },
]

// The `L` helper is retained for future seed additions that span multiple
// lines (e.g. fixture content blocks). It is intentionally not exported.
void L
