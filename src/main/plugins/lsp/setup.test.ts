/**
 * Plugin setup-downloads tests — REQ-007.
 *
 * The download path is tested at the boundary: the unit tests inject a
 * fake `fetch` (via the `fetchFn` parameter on `runOneDownload`) so we
 * never reach the network. Filesystem state is mocked with `mock-fs`.
 *
 * Coverage:
 *
 *   - happy path: download → save verbatim (`archive: 'none'`) lands a
 *     file at `extractTo/<basename(url)>`
 *   - sha256 mismatch throws
 *   - sha256 match passes
 *   - idempotence: an `extractTo` that already has contents is a no-op
 *   - path safety: an `extractTo` that escapes the plugin root throws
 *     before any network call
 */

import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mockFs from 'mock-fs';

import { runOneDownload, runPluginSetup } from './setup';
import type { LoadedPlugin, PluginSetupDownload } from '../../../types/workspace';

const PLUGIN_ROOT = '/var/hive/plugins/pub-hello';

afterEach(() => {
  mockFs.restore();
  vi.restoreAllMocks();
});

function loadedPlugin(
  downloads: PluginSetupDownload[] | undefined,
  rootPath: string = PLUGIN_ROOT,
): LoadedPlugin {
  return {
    rootPath,
    valid: true,
    manifest: {
      id: 'pub/hello',
      name: 'Hello',
      version: '0.1.0',
      setup: downloads === undefined ? undefined : { downloads },
    },
  };
}

/**
 * Build a fake `fetch` that returns `body` as a single ReadableStream
 * chunk. Pass-through to the byte-shape the real `fetch` returns.
 */
function fakeFetch(body: Uint8Array, status: number = 200): typeof fetch {
  return ((async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

describe('runOneDownload', () => {
  it('downloads + saves verbatim when archive is "none"', async () => {
    mockFs({
      [PLUGIN_ROOT]: {},
    });

    const payload = new TextEncoder().encode('hello-binary-contents');
    await runOneDownload(
      PLUGIN_ROOT,
      {
        url: 'https://example.com/server-bin',
        extractTo: 'bin',
        archive: 'none',
      },
      undefined,
      fakeFetch(payload),
    );

    const saved = await fs.readFile(`${PLUGIN_ROOT}/bin/server-bin`, 'utf8');
    expect(saved).toBe('hello-binary-contents');
  });

  it('throws on sha256 mismatch', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    const payload = new TextEncoder().encode('wrong');
    await expect(
      runOneDownload(
        PLUGIN_ROOT,
        {
          url: 'https://example.com/x.bin',
          extractTo: 'bin',
          archive: 'none',
          // sha256 of 'right'
          sha256:
            'fb6f1f9d39e8eee84df3dfb9b46d1a1d6e8a3f6e5b8a9bcedfd1f6f81d8b8e3a',
        },
        undefined,
        fakeFetch(payload),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  it('accepts a matching sha256', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    const payload = new TextEncoder().encode('right');
    // sha256('right') precomputed
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(payload).digest('hex');

    await runOneDownload(
      PLUGIN_ROOT,
      {
        url: 'https://example.com/x.bin',
        extractTo: 'bin',
        archive: 'none',
        sha256: hash,
      },
      undefined,
      fakeFetch(payload),
    );

    const saved = await fs.readFile(`${PLUGIN_ROOT}/bin/x.bin`, 'utf8');
    expect(saved).toBe('right');
  });

  it('is idempotent — skips when extractTo already has contents', async () => {
    mockFs({
      [PLUGIN_ROOT]: {
        bin: { 'already-here.bin': 'pre-existing' },
      },
    });

    const fetchSpy = vi.fn(fakeFetch(new Uint8Array()));
    await runOneDownload(
      PLUGIN_ROOT,
      { url: 'https://example.com/x.bin', extractTo: 'bin', archive: 'none' },
      undefined,
      fetchSpy as unknown as typeof fetch,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    // Pre-existing file untouched.
    const saved = await fs.readFile(`${PLUGIN_ROOT}/bin/already-here.bin`, 'utf8');
    expect(saved).toBe('pre-existing');
  });

  it('rejects an extractTo that escapes the plugin root', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    await expect(
      runOneDownload(
        PLUGIN_ROOT,
        {
          url: 'https://example.com/x.bin',
          extractTo: '../other',
          archive: 'none',
        },
        undefined,
        fakeFetch(new TextEncoder().encode('x')),
      ),
    ).rejects.toThrow(/escapes plugin root/);
  });

  it('fires progress callbacks for download + extract steps', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    const progress: string[] = [];
    await runOneDownload(
      PLUGIN_ROOT,
      { url: 'https://example.com/x.bin', extractTo: 'bin', archive: 'none' },
      (msg) => progress.push(msg),
      fakeFetch(new TextEncoder().encode('payload')),
    );
    expect(progress.some((m) => m.includes('Downloading'))).toBe(true);
    expect(progress.some((m) => m.includes('Extracting'))).toBe(true);
  });

  it('reports a failed fetch as a thrown error', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    const badFetch: typeof fetch = (async () =>
      ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: null,
      } as unknown as Response)) as unknown as typeof fetch;
    await expect(
      runOneDownload(
        PLUGIN_ROOT,
        { url: 'https://example.com/x.bin', extractTo: 'bin', archive: 'none' },
        undefined,
        badFetch,
      ),
    ).rejects.toThrow(/responded 404/);
  });
});

describe('runPluginSetup', () => {
  it('is a no-op for a plugin without setup.downloads', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    await expect(runPluginSetup(loadedPlugin(undefined))).resolves.toBeUndefined();
  });

  it('is a no-op for an invalid plugin', async () => {
    mockFs({ [PLUGIN_ROOT]: {} });
    const invalid: LoadedPlugin = {
      rootPath: PLUGIN_ROOT,
      valid: false,
      invalidReason: 'broken',
      manifest: {
        id: 'pub/hello',
        name: 'Hello',
        version: '0.1.0',
        setup: {
          downloads: [
            { url: 'https://example.com/x.bin', extractTo: 'bin' },
          ],
        },
      },
    };
    await expect(runPluginSetup(invalid)).resolves.toBeUndefined();
  });
});
