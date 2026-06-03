/**
 * Adapter: native hive model → the existing seed-shaped panel props
 * (`Board`, `Agent`, `LogLine`, `RoleKey`). Keeping it pure (no React, no
 * IPC) makes it unit-testable and keeps the panels unchanged.
 */
import type {
  Agent,
  Board,
  LogClass,
  LogLine,
  RoleKey,
  Story as SeedStory,
} from '../data/seed'
import type {
  HiveAgent,
  HiveEvent,
  HiveEventLevel,
  HiveRole,
  HiveStory,
  StoryStatus,
} from '../../../types/hive'

/** Native role → seed RoleKey (only `tech-lead`→`techlead` differs). */
function roleKey(role: HiveRole): RoleKey {
  return role === 'tech-lead' ? 'techlead' : role
}

/** Which board column a story status lands in. */
function column(status: StoryStatus): keyof Board {
  switch (status) {
    case 'in-progress':
      return 'running'
    case 'review':
      return 'review'
    case 'merged':
      return 'done'
    case 'pending':
    case 'assigned':
    case 'blocked':
    case 'abandoned':
    default:
      return 'pending'
  }
}

function toSeedStory(s: HiveStory): SeedStory {
  return {
    id: s.id,
    title: s.title,
    pts: s.points,
    role: roleKey(s.role),
    status:
      s.status === 'in-progress'
        ? 'running'
        : s.status === 'merged'
          ? 'done'
          : s.status === 'review'
            ? 'review'
            : 'pending',
  }
}

export function toBoard(stories: readonly HiveStory[]): Board {
  const board: Board = { pending: [], running: [], review: [], done: [] }
  for (const s of stories) board[column(s.status)].push(toSeedStory(s))
  return board
}

const ROLE_LABEL: Record<RoleKey, string> = {
  manager: 'Manager',
  techlead: 'Tech Lead',
  senior: 'Senior',
  intermediate: 'Intermediate',
  junior: 'Junior',
  qa: 'QA',
}

export function toRoster(agents: readonly HiveAgent[]): Agent[] {
  return agents.map((a): Agent => {
    const key = roleKey(a.role)
    const note = a.note ?? (a.currentStory ? `on ${a.currentStory}` : 'idle')
    return {
      role: key,
      name: ROLE_LABEL[key],
      status: a.status === 'live' ? 'running' : 'done',
      note,
      file: undefined,
    }
  })
}

const LEVEL_CLASS: Record<HiveEventLevel, LogClass> = {
  info: '',
  ok: 'ok',
  warn: 'dim',
  pr: 'pr',
}

/** Format an ISO timestamp to `HH:MM`, or `--:--` if unparseable. */
function hhmm(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function toLogLines(events: readonly HiveEvent[]): LogLine[] {
  return events.map((e): LogLine => {
    const txt = e.detail ? `${e.event} — ${e.detail}` : e.event
    return {
      t: hhmm(e.ts),
      cls: LEVEL_CLASS[e.level],
      txt: e.actor ? `${e.actor}: ${txt}` : txt,
    }
  })
}
