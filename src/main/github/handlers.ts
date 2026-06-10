/** `ipc:hive:github:enrich-prs` — renderer-facing enrichment endpoint. */
import { ipcMain } from 'electron';

import { enrichPrs } from './enrich';
import { resolveToken } from './token';

export const GITHUB_CHANNELS = { enrichPrs: 'ipc:hive:github:enrich-prs' } as const;

export interface GithubHandlerDeps {
  /** Read the CURRENT merged settings value for github.token. */
  getSettingsToken: () => string;
}

export function registerGithubHandlers(deps: GithubHandlerDeps): () => void {
  ipcMain.handle(GITHUB_CHANNELS.enrichPrs, async (_e, urls: unknown) => {
    if (!Array.isArray(urls) || !urls.every((u): u is string => typeof u === 'string')) {
      throw new TypeError('github: urls must be string[]');
    }
    return enrichPrs(urls, {
      fetchFn: fetch,
      getToken: () => resolveToken(deps.getSettingsToken()),
      now: () => Date.now(),
    });
  });
  return () => ipcMain.removeHandler(GITHUB_CHANNELS.enrichPrs);
}
