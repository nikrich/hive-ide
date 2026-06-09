/**
 * Native hive-orchestration types — slice 1 (state model + viewer).
 *
 * These describe BOTH the in-memory model the renderer renders AND the
 * on-disk `.hive/state/**` frontmatter contract. Fields mirror hungry-ghost-
 * hive's drawer model so the format stays compatible with the supervisor
 * built in slice 2. Files are the single source of truth — no mempalace.
 *
 * Spec: docs/specs/2026-06-03-hive-native-state-viewer-design.md
 */

export type HiveRole =
  | 'manager'
  | 'tech-lead'
  | 'senior'
  | 'intermediate'
  | 'junior'
  | 'qa';

export type StoryStatus =
  | 'pending'
  | 'proposed'
  | 'assigned'
  | 'in-progress'
  | 'review'
  | 'merged'
  | 'blocked'
  | 'abandoned'
  | 'needs-input';

export type RequirementStatus =
  | 'pending'
  | 'decomposing'
  | 'decomposed'
  | 'in-flight'
  | 'complete'
  | 'blocked';

export type AgentStatus = 'live' | 'exited';

export interface HiveStory {
  /** = filename stem. */
  id: string;
  title: string;
  status: StoryStatus;
  role: HiveRole;
  points: number;
  team: string;
  assignedTo?: string;
  featureBranch?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  parentRequirement?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  body: string;
}

export interface HiveAgent {
  id: string;
  role: HiveRole;
  status: AgentStatus;
  team: string;
  currentStory?: string;
  worktree?: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface HiveRequirement {
  id: string;
  title: string;
  status: RequirementStatus;
  featureBranch?: string;
  decomposedInto: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

export type HiveEventLevel = 'info' | 'ok' | 'warn' | 'pr';

export interface HiveEvent {
  ts: string;
  actor: string;
  event: string;
  detail: string;
  level: HiveEventLevel;
}

/** Aggregated state the renderer renders. */
export interface HiveSnapshot {
  requirements: HiveRequirement[];
  stories: HiveStory[];
  agents: HiveAgent[];
}

/** Connection status of the active project's hive workspace. */
export type HiveConnection =
  | { state: 'no-workspace' }
  | { state: 'not-found'; path: string }
  | { state: 'connected'; path: string };

/** Everything a fresh subscriber needs in one round-trip. */
export interface HiveSessionBundle {
  connection: HiveConnection;
  snapshot: HiveSnapshot;
  events: HiveEvent[];
}

/** The valid role strings (for parse-time coercion). */
export const HIVE_ROLES: readonly HiveRole[] = [
  'manager',
  'tech-lead',
  'senior',
  'intermediate',
  'junior',
  'qa',
];

/** The valid story statuses (for parse-time coercion). */
export const STORY_STATUSES: readonly StoryStatus[] = [
  'pending',
  'proposed',
  'assigned',
  'in-progress',
  'review',
  'merged',
  'blocked',
  'abandoned',
  'needs-input',
];

// ---------------------------------------------------------------------------
// Slice 2a — worker run (supervisor)
// ---------------------------------------------------------------------------

/** Lifecycle status of a single worker run, pushed to the renderer. */
export type HiveRunStatus = 'starting' | 'running' | 'exited';

/** `event:hive:run:status` payload. */
export interface HiveRunStatusEvent {
  runId: string;
  storyId: string;
  status: HiveRunStatus;
  /** Present when status === 'exited'. */
  outcome?: 'success' | 'no-commit' | 'failure' | 'interrupted' | 'needs-input';
  /** Optional human-readable detail (e.g. an error message). */
  detail?: string;
}

/** `event:hive:run:log` payload — one rendered log line. */
export interface HiveRunLogEvent {
  runId: string;
  line: string;
}

// ---------------------------------------------------------------------------
// Slice 2c — story authoring
// ---------------------------------------------------------------------------

/** Fields the New-story form collects. Shared renderer ↔ preload ↔ main. */
export interface NewStoryFields {
  title: string;
  /** Description / markdown body. */
  body: string;
  role: HiveRole;
  /** Team = a repo name in the active project. */
  team: string;
  acceptanceCriteria: string[];
}

// ---------------------------------------------------------------------------
// Slice 2b-1 — autonomous run loop + questions
// ---------------------------------------------------------------------------

/** Pushed to the renderer on every loop state change. */
export interface HiveLoopStatus {
  running: boolean;
  /** Story id currently being worked, or null when idle/stopped. */
  currentStory: string | null;
}

/** A worker's blocking question, surfaced for the operator to answer. */
export interface HiveQuestion {
  storyId: string;
  question: string;
}

// ---------------------------------------------------------------------------
// Slice 2b-2 — manager LLM (repo indexing)
// ---------------------------------------------------------------------------

/** A repo's indexed profile — `.hive/index/<repo>.md`. */
export interface RepoProfile {
  /** = filename stem = repo (team) name. */
  repo: string;
  indexedAt: string;
  /** Sha the profile was built from, when a git HEAD was reachable. */
  commit?: string;
  /** NL profile: purpose, stack, key dirs, public surface, test cmd. */
  body: string;
}

/** Per-repo indexing lifecycle surfaced in the UI. */
export type IndexStatus = 'unindexed' | 'indexing' | 'indexed' | 'failed';

/** Manager-lane run status pushed to the renderer. */
export interface HiveManagerStatusEvent {
  activity: 'indexing' | 'decomposing';
  /** repo name | requirement id. */
  target: string;
  status: 'starting' | 'running' | 'exited';
  outcome?: 'success' | 'failure';
  detail?: string;
}
