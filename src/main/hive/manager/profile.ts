/**
 * Repo-profile serialize/parse/read (pure + fs read) — slice 2b-2a.
 *
 * Mirrors `../run/serialize.ts` (the `frontmatter` helper: snake_case keys,
 * omit-undefined, trimmed body) and `../parse.ts` (`splitFrontmatter`,
 * defensive readers, skip-unreadable directory reads). The filename stem is the
 * source of truth for `repo`, never the frontmatter — so a renamed file wins.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

import type { RepoProfile } from '../../../types/hive';
import { splitFrontmatter } from '../parse';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function serializeProfile(p: RepoProfile): string {
  const data: Record<string, unknown> = {
    repo: p.repo,
    indexed_at: p.indexedAt,
    commit: p.commit,
  };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringify(clean).trimEnd();
  const body = p.body.trim();
  return `---\n${yaml}\n---\n${body ? body + '\n' : ''}`;
}

export function parseProfile(raw: string, repo: string): RepoProfile {
  const { data, body } = splitFrontmatter(raw);
  return {
    repo,
    indexedAt: str(data.indexed_at) ?? '',
    commit: str(data.commit),
    body,
  };
}

/** Read + parse every `<indexDir>/*.md`. Missing dir → []. */
export async function readProfiles(indexDir: string): Promise<RepoProfile[]> {
  let names: string[];
  try {
    names = await fs.readdir(indexDir);
  } catch {
    return [];
  }
  const out: RepoProfile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const repo = name.slice(0, -3);
    try {
      const raw = await fs.readFile(join(indexDir, name), 'utf8');
      out.push(parseProfile(raw, repo));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`hive profile: failed to read ${join(indexDir, name)}`, e);
    }
  }
  return out;
}
