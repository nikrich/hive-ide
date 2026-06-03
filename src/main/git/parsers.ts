/**
 * Pure parsers for the small handful of git command outputs we consume.
 *
 * Kept in their own module (no node imports) so they're trivially
 * unit-testable with fixture strings — no shelling out, no temp dirs.
 *
 * REQ-008 — Source control.
 */

import type { GitStatusEntry } from '../../types/workspace';

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * Porcelain v2 uses a record format that's unambiguous to parse:
 *
 *   `# branch.oid <commit> | (initial)`
 *   `# branch.head <branch> | (detached)`
 *   `# branch.upstream <upstream>`
 *   `# branch.ab +<ahead> -<behind>`
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`               — ordinary changed
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<oldPath>` — renamed/copied
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`     — unmerged (conflict)
 *   `? <path>`                                                    — untracked
 *   `! <path>`                                                    — ignored (skipped)
 *
 * With `-z`, records are NUL-terminated (LF inside paths is preserved).
 * The rename record's `oldPath` follows the `path` with one extra NUL.
 */
export function parseStatusPorcelainV2(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const records = output.split('\0');
  // Drop the trailing empty record after the final NUL.
  if (records.length > 0 && records[records.length - 1] === '') {
    records.pop();
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === '' || rec.startsWith('# ') || rec.startsWith('!')) continue;

    const kind = rec[0];

    if (kind === '?') {
      // Untracked: `? <path>`.
      const path = rec.slice(2);
      entries.push({
        path,
        state: 'untracked',
        staged: false,
        workingTree: true,
      });
      continue;
    }

    if (kind === '1') {
      // Ordinary changed entry — 9 space-separated fields then the path.
      const parsed = parseOrdinaryRecord(rec);
      if (parsed) entries.push(...parsed);
      continue;
    }

    if (kind === '2') {
      // Rename — the same 9 head fields, then `R<score>` or `C<score>`,
      // then the new path. The old path is the *next* NUL-delimited record.
      const oldPath = records[i + 1];
      i += 1;
      const parsed = parseRenameRecord(rec, oldPath ?? '');
      if (parsed) entries.push(parsed);
      continue;
    }

    if (kind === 'u') {
      // Unmerged conflict — always touches both stages.
      const path = parseUnmergedPath(rec);
      if (path !== null) {
        entries.push({
          path,
          state: 'conflicted',
          staged: true,
          workingTree: true,
        });
      }
      continue;
    }
  }

  return entries;
}

/**
 * Parse one `1 …` record. The XY field is two chars: X = index/staged,
 * Y = worktree. `.` means unchanged. One on-disk change can produce TWO
 * entries (one staged, one unstaged) — VSCode's SCM shows them as two
 * rows in two sections, which is what we want too.
 */
function parseOrdinaryRecord(rec: string): GitStatusEntry[] | null {
  // Split into 9 leading fields + the rest as the path. Format:
  // `1 XY sub mH mI mW hH hI path`
  const fields = rec.split(' ');
  if (fields.length < 9) return null;
  const xy = fields[1];
  const path = fields.slice(8).join(' ');
  if (!path) return null;

  const xCode = xy[0];
  const yCode = xy[1];
  const out: GitStatusEntry[] = [];

  if (xCode !== '.' && xCode !== '?') {
    out.push({
      path,
      state: codeToState(xCode),
      staged: true,
      workingTree: false,
    });
  }
  if (yCode !== '.' && yCode !== '?') {
    out.push({
      path,
      state: codeToState(yCode),
      staged: false,
      workingTree: true,
    });
  }
  return out.length === 0 ? null : out;
}

/**
 * Parse one `2 …` rename record + the trailing `oldPath` field. Renames
 * report XY with R/C in the X slot when staged and in the Y slot when
 * unstaged — we surface a single 'renamed' entry whichever side it lives
 * on, because VSCode's SCM also collapses these.
 */
function parseRenameRecord(
  rec: string,
  oldPath: string,
): GitStatusEntry | null {
  // Format: `2 XY sub mH mI mW hH hI Xscore path`
  const fields = rec.split(' ');
  if (fields.length < 10) return null;
  const xy = fields[1];
  // The path is fields[9..] joined — `Xscore` lives in fields[8].
  const path = fields.slice(9).join(' ');
  if (!path) return null;
  const staged = xy[0] !== '.';
  return {
    path,
    oldPath,
    state: 'renamed',
    staged,
    workingTree: !staged,
  };
}

/** Extract the path from an unmerged `u …` record. */
function parseUnmergedPath(rec: string): string | null {
  // Format: `u XY sub m1 m2 m3 mW h1 h2 h3 path`
  const fields = rec.split(' ');
  if (fields.length < 11) return null;
  return fields.slice(10).join(' ') || null;
}

/**
 * Translate a porcelain v2 XY status code to our domain enum.
 *
 * From `git status --help` (porcelain v2): M=modified, T=type changed,
 * A=added, D=deleted, R=renamed, C=copied. We collapse the rare T/C
 * cases onto 'modified' / 'added' respectively; the IDE's SCM panel
 * doesn't distinguish.
 */
function codeToState(code: string): GitStatusEntry['state'] {
  switch (code) {
    case 'M':
    case 'T':
      return 'modified';
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

// ---------------------------------------------------------------------------
// Branch output — `git branch -a --format=%(refname:short)%00%(HEAD)`
// ---------------------------------------------------------------------------

/**
 * Parse the result of `git branch --list --all --format=%(refname:short)\t%(HEAD)`.
 *
 * Each line is `<short-name>\t<*|space>`. The `*` marker is on the row
 * whose branch is currently checked out. Remote-tracking refs live
 * under `<remote>/<branch>` (e.g. `origin/main`) — we filter
 * `origin/HEAD` because it's a symbolic ref, not a real branch.
 */
export function parseBranchOutput(output: string): {
  current: string;
  local: string[];
  remote: string[];
} {
  const local: string[] = [];
  const remote: string[] = [];
  let current = '';

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const [name, head] = line.split('\t');
    if (!name) continue;
    if (head === '*') current = name;

    // Heuristic for "is this a remote-tracking ref": refname:short on a
    // remote ref produces `<remote>/<branch>`. Locals never contain a
    // leading `<remote>/` prefix in practice unless the user has done
    // something unusual; the `refs/remotes/...` paths are the canonical
    // signal but `refname:short` strips them.
    if (looksLikeRemote(name)) {
      // Skip the symbolic `origin/HEAD -> origin/main` row.
      if (name.endsWith('/HEAD')) continue;
      remote.push(name);
    } else {
      local.push(name);
    }
  }

  local.sort();
  remote.sort();
  return { current, local, remote };
}

/** Cheap remote-name detector — `<remote>/<branch>` shape. */
function looksLikeRemote(name: string): boolean {
  // A local branch may contain `/` (e.g. `feat/foo`) too — so we look
  // for known remote prefixes plus a generic heuristic for the common
  // case. The caller (`git branch -a`) emits remotes after locals; the
  // safest approach is to call this only on remote-listed lines, but
  // we don't have that signal once they're flattened. The simple rule:
  // if the first segment matches the typical remote names (`origin`,
  // `upstream`, etc.), treat as remote. That matches >99% of repos in
  // practice. The branch-output parser is a UX nicety, not a security
  // boundary.
  const first = name.split('/', 1)[0];
  return COMMON_REMOTES.has(first);
}

const COMMON_REMOTES = new Set([
  'origin',
  'upstream',
  'fork',
  'github',
  'gitlab',
  'remote',
]);

// ---------------------------------------------------------------------------
// Ahead/behind
// ---------------------------------------------------------------------------

/**
 * Parse the `# branch.ab +A -B` header line out of porcelain v2 output.
 * Returns `{ ahead: 0, behind: 0 }` when no upstream is tracked (the
 * header is omitted).
 */
/**
 * Parse entries + current branch + ahead/behind from ONE
 * `git status --porcelain=v2 --branch -z` output. Lets `fetchScm` use a
 * single git invocation per repo instead of three (status + branch +
 * ahead-behind), which is what was saturating the main process on project
 * switch. `-z` makes every header NUL-delimited, so we scan records (not
 * lines — `parseAheadBehind` is for the non-`-z` callers).
 */
export function parseStatusSummary(output: string): {
  entries: GitStatusEntry[];
  branch: string | null;
  ahead: number;
  behind: number;
} {
  const entries = parseStatusPorcelainV2(output);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const rec of output.split('\0')) {
    if (rec.startsWith('# branch.head ')) {
      const value = rec.slice('# branch.head '.length).trim();
      branch = value === '(detached)' ? null : value;
    } else if (rec.startsWith('# branch.ab ')) {
      const parts = rec.slice('# branch.ab '.length).trim().split(' ');
      if (parts.length === 2) {
        const a = parseInt(parts[0].replace('+', ''), 10);
        const b = parseInt(parts[1].replace('-', ''), 10);
        ahead = Number.isFinite(a) ? a : 0;
        behind = Number.isFinite(b) ? b : 0;
      }
    }
  }
  return { entries, branch, ahead, behind };
}

export function parseAheadBehind(output: string): {
  ahead: number;
  behind: number;
} {
  for (const line of output.split('\n')) {
    if (!line.startsWith('# branch.ab')) continue;
    const rest = line.slice('# branch.ab'.length).trim();
    // rest = `+A -B`
    const parts = rest.split(' ');
    if (parts.length !== 2) continue;
    const ahead = parseInt(parts[0].replace('+', ''), 10);
    const behind = parseInt(parts[1].replace('-', ''), 10);
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  }
  return { ahead: 0, behind: 0 };
}
