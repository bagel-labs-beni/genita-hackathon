import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type MemoryKind = "fact" | "episode";
export type Memory = {
  id: string;
  text: string;
  kind: MemoryKind;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  follow_up: boolean;
  source_session_id: string;
  image_ref?: string;
};

/** Postgres lane boundary. put is an upsert; false means a Forget tombstone blocked it.
 * delete must retain tombstones (including across restarts), never return them from list.
 * One repository instance owns a JSON file; use Postgres for multiple processes. */
export interface MemoryRepository {
  put(userId: string, memory: Memory): Promise<boolean>;
  list(userId: string): Promise<Memory[]>;
  delete(userId: string, id?: string): Promise<void>;
}

export type MemorySettings = { rememberSeen: boolean; photosOfUs: boolean };
export type CallState = {
  last_message_at: number | null;
  last_opener_day: string | null;
  revision: number;
  recent_openers: string[];
  settings: MemorySettings;
  photo_day: string;
  photo_count: number;
  photo_scenes: string[];
};
export const emptyCallState = (): CallState => ({
  last_message_at: null, last_opener_day: null, revision: 0, recent_openers: [],
  settings: { rememberSeen: true, photosOfUs: true }, photo_day: "", photo_count: 0, photo_scenes: [],
});

/** Kept separate from the memory table contract: session/privacy/quota state. */
export interface CallStateRepository {
  getState(userId: string): Promise<CallState>;
  putState(userId: string, state: CallState): Promise<void>;
}

export function memoryId(text: string): string {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return "mem_" + createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

type Bucket = { memories: Memory[]; deleted: string[]; state: CallState };
type Data = { version: 1; users: Record<string, Bucket> };
const empty = (): Data => ({ version: 1, users: {} });
// Hash user IDs so even special object keys and personal identifiers stay out of disk keys.
const userKey = (id: string) => createHash("sha256").update(id).digest("hex");
function bucket(data: Data, id: string): Bucket {
  return data.users[userKey(id)] ??= { memories: [], deleted: [], state: emptyCallState() };
}

export class InMemoryMemoryRepository implements MemoryRepository, CallStateRepository {
  protected data: Data = empty();
  private tail: Promise<unknown> = Promise.resolve();
  protected async load(): Promise<void> {}
  protected async persist(_data: Data): Promise<void> {}

  private run<T>(mutates: boolean, fn: (data: Data) => T): Promise<T> {
    const task = this.tail.then(async () => {
      await this.load();
      const data = structuredClone(this.data);
      const result = fn(data);
      if (mutates) {
        await this.persist(data);
        this.data = data;
      }
      return structuredClone(result);
    });
    this.tail = task.catch(() => {});
    return task;
  }

  put(userId: string, memory: Memory): Promise<boolean> {
    return this.run(true, (data) => {
      const b = bucket(data, userId);
      if (memory.id !== memoryId(memory.text)) throw new Error("memory id must match its text");
      if (b.deleted.includes(memory.id)) return false;
      const old = b.memories.findIndex((m) => m.id === memory.id);
      if (old >= 0) b.memories[old] = { ...memory, created_at: b.memories[old].created_at };
      else b.memories.push(memory);
      return true;
    });
  }
  list(userId: string): Promise<Memory[]> {
    return this.run(false, (data) => bucket(data, userId).memories);
  }
  delete(userId: string, id?: string): Promise<void> {
    return this.run(true, (data) => {
      const b = bucket(data, userId);
      b.deleted = [...new Set([...b.deleted, ...(id ? [id] : b.memories.map((m) => m.id))])];
      b.memories = id ? b.memories.filter((m) => m.id !== id) : [];
    });
  }
  getState(userId: string): Promise<CallState> {
    return this.run(false, (data) => bucket(data, userId).state);
  }
  putState(userId: string, state: CallState): Promise<void> {
    return this.run(true, (data) => { bucket(data, userId).state = state; });
  }
}

export class JsonMemoryRepository extends InMemoryMemoryRepository {
  private loaded = false;
  private readonly path: string;
  constructor(path: string) { super(); this.path = path; }
  protected override async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Data;
      if (parsed.version !== 1 || !parsed.users || typeof parsed.users !== "object" || Array.isArray(parsed.users)) throw new Error("invalid memory repository");
      for (const b of Object.values(parsed.users)) {
        if (!Array.isArray(b.memories) || !Array.isArray(b.deleted) || !b.state || !Number.isInteger(b.state.revision)) throw new Error("invalid memory bucket");
      }
      this.data = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }
  protected override async persist(data: Data): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      await rename(tmp, this.path);
    } finally {
      await unlink(tmp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    }
  }
}
