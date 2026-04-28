import type { AuthenticationState } from "../Types/index.ts";

// Minimal DB adapter interface — implemented by both Bun and Node drivers
// Covers every type both bun:sqlite and better-sqlite3 accept as a binding
type SqlBinding =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | Buffer;

interface DbStatement {
  run(...args: SqlBinding[]): unknown;
  get(...args: SqlBinding[]): unknown;
  all(...args: SqlBinding[]): unknown[];
}

interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

async function openDatabase(dbPath: string): Promise<DbAdapter> {
  // Bun exposes globalThis.Bun
  if (typeof globalThis.Bun !== "undefined") {
    // Dynamic import keeps this tree-shakeable in Node environments
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { create: true });

    // Wrap Bun's API to match DbAdapter
    return {
      exec: (sql: string) => db.run(sql),
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          run: (...args: any[]) => stmt.run(...args),
          get: (...args: any[]) => stmt.get(...args),
          all: (...args: any[]) => stmt.all(...args),
        };
      },
      close: () => db.close(),
    };
  }

  // Node.js — requires: npm i better-sqlite3 / yarn add better-sqlite3
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const db = new BetterSqlite3(dbPath);

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...args: unknown[]) => stmt.run(...args),
        get: (...args: unknown[]) => stmt.get(...args),
        all: (...args: unknown[]) => stmt.all(...args),
      };
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// Bridge store
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed store for the WASM bridge.
 *
 * Schema: a single `kv` table keyed by (store, key) → BLOB value.
 *
 * Behaviour preserved from the file-based implementation:
 *  - Write-through in-memory LRU cache (5 000 entries)
 *  - Critical stores (session / identity / device) are written synchronously
 *    (WAL mode + synchronous=NORMAL gives adequate crash safety)
 *  - Non-critical writes are coalesced with a 50 ms debounce
 *  - flush() drains all pending debounced writes
 */
export async function useBridgeStore(
  dbFile = "auth.db",
): Promise<NonNullable<AuthenticationState["store"]>> {
  const db = await openDatabase(dbFile);

  // WAL mode for better concurrent read performance and crash safety
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA synchronous = NORMAL`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS kv (
			store TEXT NOT NULL,
			key   TEXT NOT NULL,
			value BLOB NOT NULL,
			PRIMARY KEY (store, key)
		)
	`);

  const stmtGet = db.prepare(
    `SELECT value FROM kv WHERE store = ? AND key = ?`,
  );
  const stmtSet =
    db.prepare(`INSERT INTO kv (store, key, value) VALUES (?, ?, ?)
	                               ON CONFLICT (store, key) DO UPDATE SET value = excluded.value`);
  const stmtDelete = db.prepare(`DELETE FROM kv WHERE store = ? AND key = ?`);

  // ------------------------------------------------------------------
  // LRU write-through cache
  // ------------------------------------------------------------------

  const MAX_CACHE_ENTRIES = 5_000;
  const cache = new Map<string, Uint8Array>();

  const touchCache = (cacheKey: string, value: Uint8Array) => {
    cache.delete(cacheKey);
    cache.set(cacheKey, value);
    if (cache.size > MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value!);
    }
  };

  // ------------------------------------------------------------------
  // Debounced write queue for non-critical stores
  // ------------------------------------------------------------------

  const WRITE_DELAY_MS = 50;

  interface Pending {
    store: string;
    key: string;
    value: Uint8Array;
    timer: ReturnType<typeof setTimeout>;
  }

  const pendingWrites = new Map<string, Pending>();

  const flushWrite = (cacheKey: string) => {
    const pending = pendingWrites.get(cacheKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingWrites.delete(cacheKey);
    stmtSet.run(pending.store, pending.key, pending.value);
  };

  const flushAll = () => {
    for (const cacheKey of [...pendingWrites.keys()]) {
      flushWrite(cacheKey);
    }
  };

  // ------------------------------------------------------------------
  // Store implementation
  // ------------------------------------------------------------------

  return {
    async get(store: string, key: string): Promise<Uint8Array | null> {
      const cacheKey = `${store}\0${key}`;

      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const pending = pendingWrites.get(cacheKey);
      if (pending) return pending.value;

      const row = stmtGet.get(store, key) as { value: Uint8Array } | undefined;
      if (!row) return null;

      // SQLite drivers return Buffer (Node) or Uint8Array (Bun); normalise
      const arr =
        row.value instanceof Uint8Array
          ? row.value
          : new Uint8Array(
              (row.value as Buffer).buffer,
              (row.value as Buffer).byteOffset,
              (row.value as Buffer).byteLength,
            );

      touchCache(cacheKey, arr);
      return arr;
    },

    async set(store: string, key: string, value: Uint8Array): Promise<void> {
      const cacheKey = `${store}\0${key}`;

      // Skip identical writes
      const prev = cache.get(cacheKey);
      if (
        prev &&
        prev.length === value.length &&
        prev.every((b, i) => b === value[i])
      ) {
        return;
      }

      touchCache(cacheKey, value);

      // Critical stores: write immediately, bypass debounce
      const critical =
        store === "session" || store === "identity" || store === "device";
      if (critical) {
        const existing = pendingWrites.get(cacheKey);
        if (existing) {
          clearTimeout(existing.timer);
          pendingWrites.delete(cacheKey);
        }
        stmtSet.run(store, key, value);
        return;
      }

      // Non-critical: coalesce rapid writes
      const existing = pendingWrites.get(cacheKey);
      if (existing) {
        clearTimeout(existing.timer);
      }

      const timer = setTimeout(() => flushWrite(cacheKey), WRITE_DELAY_MS);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref();
      }
      pendingWrites.set(cacheKey, { store, key, value, timer });
    },

    async delete(store: string, key: string): Promise<void> {
      const cacheKey = `${store}\0${key}`;
      cache.delete(cacheKey);

      const existing = pendingWrites.get(cacheKey);
      if (existing) {
        clearTimeout(existing.timer);
        pendingWrites.delete(cacheKey);
      }

      stmtDelete.run(store, key);
    },

    /**
     * Flush all pending debounced writes and optionally close the DB.
     * Pass `{ close: true }` during shutdown to release the file handle.
     */
    async flush(opts?: { close?: boolean }): Promise<void> {
      flushAll();
      if (opts?.close) db.close();
    },
  };
}
