/**
 * Fabricates a hermetic project for one e2e test:
 *  - a real git repo with committed files + two prepared working-tree hunks
 *  - a `.hive` tree (stories/agents/requirements + events/chat ndjson)
 *  - a seeded userData dir whose workspace.json points at the project
 * Mutators (appendEvent/appendChat/writeStory/writeQuestion) let tests drive
 * the app's file-watch pipeline mid-run. Pure Node — no Playwright imports.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Fixture {
  /** Project root (= git repo root = hive workspace). */
  root: string;
  /** Throwaway userData dir seeded with workspace.json. */
  userDataDir: string;
  story(id: string, front: Record<string, unknown>, body?: string): void;
  agent(id: string, front: Record<string, unknown>): void;
  requirement(id: string, front: Record<string, unknown>, body?: string): void;
  question(storyId: string, text: string): void;
  appendEvent(e: { actor: string; event: string; detail?: string; level?: string }): void;
  appendChat(m: { who: string; txt: string }): void;
  readStory(id: string): string;
  git(...args: string[]): string;
  dispose(): void;
}

function yaml(front: Record<string, unknown>): string {
  const lines = Object.entries(front).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      return `${k}:\n${v.map((x) => `  - ${String(x)}`).join('\n')}`;
    }
    return `${k}: ${String(v)}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'hive-e2e-'));
  const root = join(base, 'repo');
  const userDataDir = join(base, 'user-data');
  mkdirSync(root, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  // --- repo with two well-separated hunks ---------------------------------
  git('init', '-q', '-b', 'main');
  const appJs = [
    ...Array.from({ length: 10 }, (_, i) => `function alpha${i + 1}() { return ${i + 1} }`),
    ...Array.from({ length: 5 }, () => '// section break'),
    ...Array.from({ length: 10 }, (_, i) => `function beta${i + 1}() { return ${i + 1} }`),
  ];
  writeFileSync(join(root, 'app.js'), appJs.join('\n') + '\n');
  writeFileSync(join(root, 'notes.txt'), 'foo target one\nkeep foo here\nfoo target three\n');
  writeFileSync(join(root, 'lib.ts'), 'export function gammaOne(): number { return 1 }\nexport function gammaTwo(): number { return gammaOne() }\n');
  git('add', '-A');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  appJs[1] = 'function alpha2() { return 222 } // HUNK-ONE';
  appJs[20] = 'function beta6() { return 666 } // HUNK-TWO';
  writeFileSync(join(root, 'app.js'), appJs.join('\n') + '\n');

  // --- .hive tree ----------------------------------------------------------
  const hive = join(root, '.hive');
  for (const d of ['state/stories', 'state/agents', 'state/requirements', 'state/questions']) {
    mkdirSync(join(hive, d), { recursive: true });
  }
  writeFileSync(join(hive, 'events.ndjson'), '');
  writeFileSync(join(hive, 'chat.ndjson'), '');

  // --- seeded userData -----------------------------------------------------
  const projectId = 'e2e-0000-0000-0000-000000000001';
  const now = Date.now();
  writeFileSync(
    join(userDataDir, 'workspace.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        lastProjectId: projectId,
        recents: [{ id: projectId, name: 'E2E Project', repoCount: 1, lastOpenedAt: now }],
        projects: {
          [projectId]: {
            id: projectId,
            name: 'E2E Project',
            repos: [{ name: 'repo', path: root, isGitRepo: true }],
            createdAt: now,
            lastOpenedAt: now,
            hiveWorkspacePath: root,
            expandedPaths: [],
          },
        },
        // layout must have all three numeric fields — hasV3Shape checks them
        layout: { explorerWidth: 256, dockWidth: 344, panelHeight: 232 },
        // enabledPlugins must be a Record<string, string[]>, not an array
        enabledPlugins: {},
        // terminals must carry the four fields — isValidV6 checks panelTerminals
        // and termSessions as arrays, and the two activeId fields as null|string
        terminals: {
          panelTerminals: [],
          activePanelTerminalId: null,
          termSessions: [],
          activeTermSessionId: null,
        },
        window: { width: 1400, height: 950 },
      },
      null,
      2,
    ),
  );

  return {
    root,
    userDataDir,
    story: (id, front, body = '') =>
      writeFileSync(join(hive, 'state/stories', `${id}.md`), yaml(front) + body),
    agent: (id, front) =>
      writeFileSync(join(hive, 'state/agents', `${id}.md`), yaml(front)),
    requirement: (id, front, body = '') =>
      writeFileSync(join(hive, 'state/requirements', `${id}.md`), yaml(front) + body),
    question: (storyId, text) =>
      writeFileSync(join(hive, 'state/questions', `${storyId}.md`), text),
    appendEvent: (e) =>
      appendFileSync(
        join(hive, 'events.ndjson'),
        JSON.stringify({ ts: new Date().toISOString(), detail: '', level: 'info', ...e }) + '\n',
      ),
    appendChat: (m) =>
      appendFileSync(
        join(hive, 'chat.ndjson'),
        JSON.stringify({ ts: new Date().toISOString(), ...m }) + '\n',
      ),
    readStory: (id) => readFileSync(join(hive, 'state/stories', `${id}.md`), 'utf8'),
    git,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}
