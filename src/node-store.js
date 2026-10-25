import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packState, unpackState } from './store.js';

// Census namespaces contain a colon, which is not a legal filename on every platform.
const safe = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * A directory as a collector store: one gzipped snapshot, one map file and one file per continent.
 * Writes go to a temporary name and are renamed, so a crash mid-write cannot leave a half file.
 * Phase 2 (docs/ARCHITECTURE.md) replaces the snapshot with PostgreSQL; the geometry becomes a table.
 */
export function createNodeStore(dir) {
  const path = (name) => join(dir, name);
  let ready = null;
  const ensureDir = () => (ready ||= mkdir(dir, { recursive: true }));

  async function writeAtomic(name, bytes) {
    await ensureDir();
    const tmp = path(`${name}.${process.pid}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, path(name));
  }

  async function readJson(name) {
    try {
      return JSON.parse(await readFile(path(name), 'utf8'));
    } catch {
      return null; // missing or corrupt: the caller starts empty or refetches
    }
  }

  return {
    async readState() {
      let gz;
      try {
        gz = await readFile(path('state.gz'));
      } catch {
        return null; // first boot
      }
      const restored = await unpackState([new Uint8Array(gz)]);
      if (!restored) console.warn('snapshot unreadable, starting empty');
      return restored;
    },
    async writeState(state) {
      const chunks = await packState(state);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const gz = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        gz.set(c, at);
        at += c.length;
      }
      await writeAtomic('state.gz', gz);
    },
    readMap: async () => (await readJson('map.json')) ?? undefined,
    writeMap: (snap) => writeAtomic('map.json', JSON.stringify(snap)),
    readStatic: (key) => readJson(`static-${safe(key)}.json`),
    writeStatic: (key, geo) => writeAtomic(`static-${safe(key)}.json`, JSON.stringify(geo)),
  };
}
