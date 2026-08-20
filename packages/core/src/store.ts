import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Minimal record store. Implemented in-memory and on-disk here; the same three
 * methods map directly onto a Supabase table with Row Level Security, where
 * `collection` is the table and `id` the primary key. Keeping the surface this
 * small is what makes the Supabase swap a single file.
 */
export interface Store {
  get<T>(collection: string, id: string): Promise<T | null>;
  put<T>(collection: string, id: string, value: T): Promise<void>;
  list<T>(collection: string): Promise<Array<{ id: string; value: T }>>;
  delete(collection: string, id: string): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryStore implements Store {
  readonly #data = new Map<string, Map<string, string>>();

  #bucket(collection: string): Map<string, string> {
    let bucket = this.#data.get(collection);
    if (!bucket) {
      bucket = new Map();
      this.#data.set(collection, bucket);
    }
    return bucket;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const raw = this.#bucket(collection).get(id);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    this.#bucket(collection).set(id, JSON.stringify(value));
  }

  async list<T>(collection: string): Promise<Array<{ id: string; value: T }>> {
    return [...this.#bucket(collection).entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, raw]) => ({ id, value: JSON.parse(raw) as T }));
  }

  async delete(collection: string, id: string): Promise<void> {
    this.#bucket(collection).delete(id);
  }
}

/** JSON-file-per-record store, so a local run survives process restarts. */
export class FileStore implements Store {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #path(collection: string, id: string): string {
    if (!/^[\w.-]+$/.test(collection) || !/^[\w.-]+$/.test(id)) {
      throw new Error(`unsafe store key: ${collection}/${id}`);
    }
    return join(this.#root, collection, `${id}.json`);
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.#path(collection, id), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    const path = this.#path(collection, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async list<T>(collection: string): Promise<Array<{ id: string; value: T }>> {
    let names: string[];
    try {
      names = await readdir(join(this.#root, collection));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const ids = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
    const out: Array<{ id: string; value: T }> = [];
    for (const id of ids) {
      const value = await this.get<T>(collection, id);
      if (value !== null) out.push({ id, value });
    }
    return out;
  }

  async delete(collection: string, id: string): Promise<void> {
    await rm(this.#path(collection, id), { force: true });
  }
}

export { clone };
