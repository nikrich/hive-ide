/**
 * Adapter: native hive model → the existing seed-shaped panel props
 * (`Board`, `Agent`, `LogLine`, `RoleKey`). Keeping it pure (no React, no
 * IPC) makes it unit-testable and keeps the panels unchanged.
 */
import type {
  Agent,
  Board,
  ChatMsg,
  LogClass,
  LogLine,
  RoleKey,
  Story as SeedStory,
} from '../data/seed'
import type {
  HiveAgent,
  HiveChatMessage,
  HiveEvent,
  HiveEventLevel,
  HiveRequirement,
  HiveRole,
  HiveStory,
  RequirementStatus,
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
  for (const s of stories) {
    // needs-input stories wait on the operator, not the loop — surface them
    // via toNeedsInput instead of cluttering the board columns.
    // proposed stories await approval — surface them via toRequirementCards instead.
    if (s.status === 'needs-input' || s.status === 'proposed') continue
    board[column(s.status)].push(toSeedStory(s))
  }
  return board
}

/** needs-input stories, as board-card shapes, for the Dock answer panel. */
export function toNeedsInput(stories: readonly HiveStory[]): SeedStory[] {
  return stories.filter((s) => s.status === 'needs-input').map(toSeedStory)
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

/** Native chat messages → the Dock ChatPanel's seed-shaped ChatMsg. */
export function toChatMsgs(msgs: readonly HiveChatMessage[]): ChatMsg[] {
  return msgs.map((m): ChatMsg => {
    if (m.who === 'you') return { who: 'you', txt: m.txt }
    const key = roleKey(m.who)
    return { who: key, role: key, txt: m.txt }
  })
}

export interface ProposedStoryCard {
  id: string
  title: string
  role: RoleKey
  /** Routed repo name (story.team). */
  team: string
  /** True when `team` is not one of the project's repo names. */
  unknownRepo: boolean
}

export interface RequirementCard {
  id: string
  title: string
  status: RequirementStatus
  /** Proposed stories grouped under this requirement (empty until decomposed). */
  proposed: ProposedStoryCard[]
}

export interface PrCard {
  storyId: string
  /** PR number parsed from the URL tail, or null when unparsable. */
  num: number | null
  title: string
  role: RoleKey
  branch: string
  status: 'review' | 'merged'
  url: string
  /** Relative age, e.g. `12m ago`. */
  time: string
}

/**
 * Coarse relative-age formatter (`just now` / `Nm ago` / `Nh ago` / `Nd ago`).
 * Intentionally separate from `lib/relativeTime.ts`'s long-form
 * `formatRelativeTime` — the PR card's meta-mono row needs this compact
 * format; don't dedupe them.
 */
function timeAgo(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((now.getTime() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Stories carrying a `prUrl` → PR cards, newest activity first. */
export function toPrCards(
  stories: readonly HiveStory[],
  now: Date = new Date(),
): PrCard[] {
  return stories
    .filter((s): s is HiveStory & { prUrl: string } => typeof s.prUrl === 'string' && s.prUrl !== '')
    .sort((a, b) => (b.mergedAt ?? b.updatedAt).localeCompare(a.mergedAt ?? a.updatedAt))
    .map((s): PrCard => {
      const numMatch = /\/(\d+)\/?$/.exec(s.prUrl)
      return {
        storyId: s.id,
        num: numMatch ? Number(numMatch[1]) : null,
        title: s.title,
        role: roleKey(s.role),
        branch: s.featureBranch ?? '',
        status: s.status === 'merged' ? 'merged' : 'review',
        url: s.prUrl,
        time: timeAgo(s.mergedAt ?? s.updatedAt, now),
      }
    })
}

/**
 * Group `proposed` stories under their parent requirement. Pending requirements
 * (not yet decomposed) are omitted — there is nothing to review. `repoNames` is
 * the active project's repo names, for the unknown-repo (⚠) flag.
 */
export function toRequirementCards(
  requirements: readonly HiveRequirement[],
  stories: readonly HiveStory[],
  repoNames: readonly string[],
): RequirementCard[] {
  const known = new Set(repoNames)
  const byReq = new Map<string, ProposedStoryCard[]>()
  for (const s of stories) {
    if (s.status !== 'proposed' || !s.parentRequirement) continue
    const card: ProposedStoryCard = {
      id: s.id,
      title: s.title,
      role: roleKey(s.role),
      team: s.team,
      unknownRepo: !known.has(s.team),
    }
    const list = byReq.get(s.parentRequirement)
    if (list) list.push(card)
    else byReq.set(s.parentRequirement, [card])
  }
  return requirements
    .filter((r) => r.status !== 'pending')
    .map((r): RequirementCard => ({
      id: r.id,
      title: r.title,
      status: r.status,
      proposed: byReq.get(r.id) ?? [],
    }))
}
