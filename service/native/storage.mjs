import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, link, unlink, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip),
  expand = promisify(gunzip);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const FORMAT = 'compacta.snapshot/1';
const validID = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

// Large strings (images, repeated instructions, tool output) are immutable and
// shared across checkpoints. The transcript itself remains exactly recoverable.
export class SnapshotStore {
  constructor(root) {
    this.root = root;
    this.objectRoot = join(root, 'objects');
    this.known = new Set();
    this.pending = new Map();
    this.locks = new Map();
    this.activeWrites = 0;
    this.activeReads = 0;
    this.collecting = null;
    this.optimizing = null;
    this.stats = {
      running: false,
      processed: 0,
      migrated: 0,
      savedBytes: 0,
      errors: 0,
      complete: false,
    };
  }
  objectPath(id) {
    if (!validID(id)) throw Error('invalid_snapshot_object');
    return join(this.objectRoot, id.slice(0, 2), id + '.gz');
  }
  async withWrite(path, action) {
    const previous = this.locks.get(path) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        while (this.collecting) await this.collecting;
        this.activeWrites++;
        try {
          return await action();
        } finally {
          this.activeWrites--;
        }
      });
    this.locks.set(path, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(path) === operation) this.locks.delete(path);
    }
  }
  async putString(text) {
    // JSON encoding preserves even unpaired UTF-16 surrogates losslessly.
    const bytes = Buffer.from(JSON.stringify(text));
    const id = digest(bytes);
    if (this.known.has(id)) return { id, bytes: bytes.length };
    let pending = this.pending.get(id);
    if (!pending) {
      pending = (async () => {
        const path = this.objectPath(id);
        try {
          await stat(path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const tmp = path + '.' + randomUUID() + '.tmp';
          await writeFile(tmp, await compress(bytes, { level: 6 }), { mode: 0o600 });
          try {
            await link(tmp, path);
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          } finally {
            await unlink(tmp);
          }
        }
        this.known.add(id);
      })();
      this.pending.set(id, pending);
    }
    try {
      await pending;
    } finally {
      if (this.pending.get(id) === pending) this.pending.delete(id);
    }
    return { id, bytes: bytes.length };
  }
  async encode(value) {
    const blobs = [];
    const visit = async (x, path) => {
      if (typeof x === 'string' && x.length >= 4096) {
        blobs.push({ path, ...(await this.putString(x)) });
        return null;
      }
      if (Array.isArray(x)) {
        const result = [];
        for (let i = 0; i < x.length; i++) result.push(await visit(x[i], [...path, i]));
        return result;
      }
      if (x && typeof x === 'object') {
        const result = [];
        for (const [key, v] of Object.entries(x))
          result.push([key, await visit(v, [...path, key])]);
        return Object.fromEntries(result);
      }
      return x;
    };
    const data = await visit(value, []);
    return { format: FORMAT, data, blobs, digest: digest(JSON.stringify({ data, blobs })) };
  }
  async read(path) {
    while (this.collecting) await this.collecting;
    this.activeReads++;
    try {
      return await this.readSnapshot(path);
    } finally {
      this.activeReads--;
    }
  }
  async readSnapshot(path) {
    const wrapper = JSON.parse(await readFile(path, 'utf8'));
    if (wrapper?.format !== FORMAT) return wrapper;
    const { data, blobs } = wrapper;
    if (!Array.isArray(blobs) || digest(JSON.stringify({ data, blobs })) !== wrapper.digest)
      throw Error('invalid_snapshot_manifest');
    let result = data;
    const loaded = new Map();
    for (const ref of blobs) {
      if (!validID(ref.id) || !Array.isArray(ref.path)) throw Error('invalid_snapshot_reference');
      let text = loaded.get(ref.id);
      if (text === undefined) {
        const bytes = await expand(await readFile(this.objectPath(ref.id)));
        if (bytes.length !== ref.bytes || digest(bytes) !== ref.id)
          throw Error('corrupt_snapshot_object');
        text = JSON.parse(bytes.toString());
        if (typeof text !== 'string') throw Error('invalid_snapshot_string');
        loaded.set(ref.id, text);
      }
      if (ref.path.length === 0) {
        result = text;
        continue;
      }
      let parent = result;
      for (const key of ref.path.slice(0, -1)) {
        if (!parent || !Object.hasOwn(parent, key)) throw Error('invalid_snapshot_path');
        parent = parent[key];
      }
      const key = ref.path.at(-1);
      if (!parent || !Object.hasOwn(parent, key) || parent[key] !== null)
        throw Error('invalid_snapshot_path');
      Object.defineProperty(parent, key, {
        value: text,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  async publish(path, value, verify = false) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const wrapper = await this.encode(value);
    const tmp = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify(wrapper), { mode: 0o600 });
      if (verify && digest(JSON.stringify(await this.read(tmp))) !== digest(JSON.stringify(value)))
        throw Error('snapshot_roundtrip_failed');
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
  write(path, value) {
    return this.withWrite(path, () => this.publish(path, value));
  }
  remove(path) {
    return this.withWrite(path, () =>
      unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      }),
    );
  }
  async migrate(path) {
    return this.withWrite(path, async () => {
      const raw = await readFile(path, 'utf8');
      const value = JSON.parse(raw);
      if (value?.format === FORMAT) return false;
      await this.publish(path, value, true);
      this.stats.savedBytes += Math.max(0, Buffer.byteLength(raw) - (await stat(path)).size);
      return true;
    });
  }
  optimize() {
    if (this.optimizing) return this.optimizing;
    this.stats.running = true;
    this.optimizing = (async () => {
      for (const directory of ['archive', 'cache']) {
        let names;
        try {
          names = await readdir(join(this.root, directory));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        for (const name of names) {
          if (this.stopping) break;
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          try {
            if (await this.migrate(join(this.root, directory, name))) this.stats.migrated++;
          } catch {
            this.stats.errors++;
          }
          this.stats.processed++;
          if (this.stats.processed % 16 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
            globalThis.Bun?.gc?.(false);
          }
        }
      }
      this.stats.complete = !this.stopping && this.stats.errors === 0;
      return this.stats;
    })().finally(() => {
      this.stats.running = false;
    });
    return this.optimizing;
  }
  async collectGarbage(graceMs = 3600000) {
    if (this.activeWrites || this.activeReads || this.collecting) return { skipped: true };
    const started = Date.now();
    this.collecting = (async () => {
      const references = new Set();
      for (const directory of ['archive', 'cache', 'responses']) {
        let names;
        try {
          names = await readdir(join(this.root, directory));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const wrapper = JSON.parse(await readFile(join(this.root, directory, name), 'utf8'));
          if (wrapper?.format !== FORMAT) continue;
          if (
            digest(JSON.stringify({ data: wrapper.data, blobs: wrapper.blobs })) !== wrapper.digest
          )
            throw Error('invalid_snapshot_manifest');
          for (const ref of wrapper.blobs) references.add(ref.id);
        }
      }
      let removed = 0,
        bytes = 0;
      for (const directory of await readdir(this.objectRoot).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })) {
        if (!/^[a-f0-9]{2}$/.test(directory)) continue;
        for (const name of await readdir(join(this.objectRoot, directory))) {
          const id = name.slice(0, -3);
          if (!name.endsWith('.gz') || !validID(id) || references.has(id)) continue;
          const path = join(this.objectRoot, directory, name),
            info = await stat(path);
          if (info.mtimeMs >= started - graceMs) continue;
          await unlink(path);
          this.known.delete(id);
          removed++;
          bytes += info.size;
        }
      }
      return { removed, bytes };
    })();
    try {
      return await this.collecting;
    } finally {
      this.collecting = null;
    }
  }
}
