import { Database } from "bun:sqlite";
import type { AuthenticationState } from "../Types/index.ts";

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

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
	const db = new Database(dbPath, { create: true });
	return {
		exec: (sql: string) => db.run(sql),
		prepare: (sql: string) => {
			const stmt = db.prepare(sql);
			return {
				run: (...args: SqlBinding[]) =>
					stmt.run(...(args as Parameters<typeof stmt.run>)),
				get: (...args: SqlBinding[]) =>
					stmt.get(...(args as Parameters<typeof stmt.get>)),
				all: (...args: SqlBinding[]) =>
					stmt.all(...(args as Parameters<typeof stmt.all>))
			};
		},
		close: () => db.close()
	};
}

export async function useBridgeStore(
	file = "session.db"
): Promise<NonNullable<AuthenticationState["store"]>> {
	const db = await openDatabase(file);

	db.exec(`PRAGMA journal_mode = WAL`);
	db.exec(`PRAGMA synchronous = NORMAL`);

	const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

	interface StoreStatements {
		get: DbStatement;
		set: DbStatement;
		del: DbStatement;
	}

	const stmtCache = new Map<string, StoreStatements>();

	const ensureTable = (store: string): StoreStatements => {
		const hit = stmtCache.get(store);
		if (hit) return hit;

		if (!SAFE_TABLE_NAME.test(store)) {
			throw new Error(
				`Invalid store name: "${store}". Only alphanumeric characters and underscores are allowed.`
			);
		}

		db.exec(`
			CREATE TABLE IF NOT EXISTS "${store}" (
				key   TEXT NOT NULL PRIMARY KEY,
				value BLOB NOT NULL
			)
		`);

		const stmts: StoreStatements = {
			get: db.prepare(`SELECT value FROM "${store}" WHERE key = ?`),
			set: db.prepare(
				`INSERT INTO "${store}" (key, value) VALUES (?, ?)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
			),
			del: db.prepare(`DELETE FROM "${store}" WHERE key = ?`)
		};

		stmtCache.set(store, stmts);
		return stmts;
	};

	const MAX_CACHE_ENTRIES = 5_000;
	const cache = new Map<string, Uint8Array>();

	const touchCache = (cacheKey: string, value: Uint8Array) => {
		cache.delete(cacheKey);
		cache.set(cacheKey, value);
		if (cache.size > MAX_CACHE_ENTRIES) {
			cache.delete(cache.keys().next().value!);
		}
	};

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
		ensureTable(pending.store).set.run(pending.key, pending.value);
	};

	const flushAll = () => {
		for (const cacheKey of pendingWrites.keys()) {
			flushWrite(cacheKey);
		}
	};

	return {
		async get(store: string, key: string): Promise<Uint8Array | null> {
			const cacheKey = `${store}\0${key}`;

			const cached = cache.get(cacheKey);
			if (cached) return cached;

			const pending = pendingWrites.get(cacheKey);
			if (pending) return pending.value;

			const row = ensureTable(store).get.get(key) as
				| { value: Uint8Array }
				| undefined;

			if (!row) return null;

			const arr = row.value;
			touchCache(cacheKey, arr);
			return arr;
		},

		async set(store: string, key: string, value: Uint8Array): Promise<void> {
			const cacheKey = `${store}\0${key}`;

			const prev = cache.get(cacheKey);
			if (
				prev &&
				prev.length === value.length &&
				prev.every((b, i) => b === value[i])
			) {
				return;
			}

			touchCache(cacheKey, value);

			const critical =
				store === "session" || store === "identity" || store === "device";
			if (critical) {
				const existing = pendingWrites.get(cacheKey);
				if (existing) {
					clearTimeout(existing.timer);
					pendingWrites.delete(cacheKey);
				}
				ensureTable(store).set.run(key, value);
				return;
			}

			const existing = pendingWrites.get(cacheKey);
			if (existing) {
				clearTimeout(existing.timer);
			}

			const timer = setTimeout(() => flushWrite(cacheKey), WRITE_DELAY_MS);
			if (typeof timer === "object" && "unref" in timer) {
				(timer as any).unref();
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

			ensureTable(store).del.run(key);
		},

		async flush(opts?: { close?: boolean }): Promise<void> {
			flushAll();
			if (opts?.close) db.close();
		}
	};
}
