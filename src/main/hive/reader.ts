/**
 * Hive state reader — owns the ONE active hive workspace at a time.
 *
 * Given a workspace path, it watches `<ws>/.hive/state/` + `<ws>/.hive/events.ndjson`
 * with chokidar (same approach as the project watcher), re-reads on change,
 * and pushes `HiveSnapshot` / `HiveEvent[]` / `HiveConnection` to the renderer
 * via the injected `send`. Files are the source of truth — see parse.ts.
 */
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

import type {
  HiveConnection,
  HiveEvent,
  HiveSessionBundle,
  HiveSnapshot,
} from '../../types/hive';
import { parseEventLine, readSnapshot } from './parse';

const DEBOUNCE_MS = 100;
const MAX_TAIL = 500;

export const HIVE_EVENTS = {
  snapshot: 'event:hive:snapshot',
  events: 'event:hive:events',
  connection: 'event:hive:connection',
} as const;

type Send = (channel: string, payload: unknown) => void;

const EMPTY_SNAPSHOT: HiveSnapshot = { requirements: [], stories: [], agents: [] };

class HiveReader {
  #send: Send | null = null;
  #watcher: FSWatcher | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;

  #workspacePath: string | null = null;
  #connection: HiveConnection = { state: 'no-workspace' };
  #snapshot: HiveSnapshot = EMPTY_SNAPSHOT;
  #events: HiveEvent[] = [];
  #eventBytes = 0; // how many bytes of events.ndjson we've consumed

  setSend(send: Send): void {
    this.#send = send;
  }

  /** Re-point at a workspace (or null to disconnect). Returns the fresh bundle. */
  async setWorkspace(path: string | null): Promise<HiveSessionBundle> {
    this.#teardownWatcher();
    this.#workspacePath = path;
    this.#snapshot = EMPTY_SNAPSHOT;
    this.#events = [];
    this.#eventBytes = 0;

    if (!path) {
      this.#connection = { state: 'no-workspace' };
      return this.bundle();
    }
    if (!existsSync(join(path, '.hive'))) {
      this.#connection = { state: 'not-found', path };
      return this.bundle();
    }
    this.#connection = { state: 'connected', path };
    await this.#reloadSnapshot();
    await this.#reloadEvents(true);
    this.#startWatcher(path);
    return this.bundle();
  }

  bundle(): HiveSessionBundle {
    return {
      connection: this.#connection,
      snapshot: this.#snapshot,
      events: this.#events,
    };
  }

  teardown(): void {
    this.#teardownWatcher();
    this.#workspacePath = null;
    this.#send = null;
  }

  // --- internals --------------------------------------------------------

  #stateDir(): string {
    return join(this.#workspacePath as string, '.hive', 'state');
  }
  #eventsFile(): string {
    return join(this.#workspacePath as string, '.hive', 'events.ndjson');
  }

  #startWatcher(path: string): void {
    const watcher = chokidarWatch(
      [join(path, '.hive', 'state'), join(path, '.hive', 'events.ndjson')],
      { ignoreInitial: true, persistent: true },
    );
    watcher.on('all', () => this.#scheduleReload());
    watcher.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('hive reader: watcher error', e);
    });
    this.#watcher = watcher;
  }

  #scheduleReload(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.#reloadSnapshot().then(() => this.#reloadEvents(false));
    }, DEBOUNCE_MS);
  }

  async #reloadSnapshot(): Promise<void> {
    if (!this.#workspacePath) return;
    try {
      this.#snapshot = await readSnapshot(this.#stateDir());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('hive reader: snapshot read failed', e);
      this.#snapshot = EMPTY_SNAPSHOT;
    }
    this.#send?.(HIVE_EVENTS.snapshot, this.#snapshot);
  }

  /** Read events.ndjson; on `full`, parse all, else only the appended tail. */
  async #reloadEvents(full: boolean): Promise<void> {
    if (!this.#workspacePath) return;
    let raw: string;
    try {
      const buf = await fs.readFile(this.#eventsFile());
      // If the file shrank (rotated/truncated), re-read from the start.
      if (buf.byteLength < this.#eventBytes) {
        this.#eventBytes = 0;
        this.#events = [];
        full = true;
      }
      raw = full ? buf.toString('utf8') : buf.subarray(this.#eventBytes).toString('utf8');
      this.#eventBytes = buf.byteLength;
    } catch {
      return; // no events file yet
    }
    const fresh: HiveEvent[] = [];
    for (const line of raw.split('\n')) {
      const ev = parseEventLine(line);
      if (ev) fresh.push(ev);
    }
    if (fresh.length === 0) return;
    this.#events = [...this.#events, ...fresh].slice(-MAX_TAIL);
    this.#send?.(HIVE_EVENTS.events, fresh);
  }

  #teardownWatcher(): void {
    if (this.#debounce) {
      clearTimeout(this.#debounce);
      this.#debounce = null;
    }
    if (this.#watcher) {
      void this.#watcher.close();
      this.#watcher = null;
    }
  }
}

/** Process-wide singleton — one active workspace at a time. */
export const hiveReader = new HiveReader();
