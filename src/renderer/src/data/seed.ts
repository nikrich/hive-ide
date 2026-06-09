/**
 * Hive IDE — prop SHAPES for the hive panels + the role palette.
 *
 * This module no longer ships demo data. The hive panels (Dock board /
 * roster / chat, BottomPanel manager.log, PRsView) are live: their data is
 * derived from `.hive/**` files via the adapters in `lib/hiveView.ts` and
 * fed down as props shaped like the types below. The old demo arrays
 * (`board`, `roster`, `log`, `chat`, `problems`, `prs`) were removed once
 * the panels went live — only the type contracts and the `ROLE` palette
 * remain.
 */

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
// Orchestration panel shapes: board, roster, log, chat
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

export type AgentStatus = 'running' | 'done' | 'review' | 'pending'

export interface Agent {
  role: RoleKey
  name: string
  status: AgentStatus
  note: string
  /** Path of the file this agent is currently editing, when applicable. */
  file?: string
}

/** Visual class applied to a manager log line in the bottom panel. */
export type LogClass = '' | 'dim' | 'ok' | 'pr'

export interface LogLine {
  t: string
  cls: LogClass
  txt: string
}

export interface ChatMsg {
  /** Speaker — either the operator ('you') or one of the role agents. */
  who: 'you' | RoleKey
  /** Role colour pill, when the speaker is an agent. */
  role?: RoleKey
  txt: string
}
