import { Buffer } from "buffer";
import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import {
	createWhatsAppClient,
	type DevicePlatformType,
	encodeProto,
	initWasmEngine,
	type MediaType,
	type UploadMediaResult,
	type WasmWhatsAppClient
} from "whatsapp-rust-bridge";
import type { proto } from "whatsapp-rust-bridge/proto-types";
import { DEFAULT_CONNECTION_CONFIG } from "../Defaults/index.ts";
import type {
	BinaryNode,
	ConnectionState,
	Contact,
	LIDMapping,
	ReachoutTimelockState,
	UserFacingSocketConfig,
	WAMessage
} from "../Types/index.ts";
import { DisconnectReason } from "../Types/index.ts";
import { Boom } from "../Utils/boom.ts";
import { makeEventBuffer } from "../Utils/event-buffer.ts";
import type { ILogger } from "../Utils/logger.ts";
import {
	_registerActiveBridgeClient,
	downloadMediaMessage
} from "../Utils/messages.ts";
import type { MediaDownloadOptions } from "../Utils/messages-media.ts";
import { makeBlockingMethods } from "./blocking.ts";
import { makeChatActionMethods } from "./chat-actions.ts";
import { makeContactMethods } from "./contacts.ts";
import { makeEventHandler } from "./events.ts";
import { makeGroupMethods } from "./groups.ts";
import { makeMessageMethods } from "./messages.ts";
import { makeNewsletterMethods } from "./newsletter.ts";
import { makePresenceMethods } from "./presence.ts";
import { makeProfileMethods } from "./profile.ts";
import { mapReachoutTimelock } from "./reachout.ts";
import { makeHttpClient, makeTransport } from "./transport.ts";
import type { SocketContext } from "./types.ts";
import { makeCryptoProvider } from "../Utils/crypto-provider.ts";
import { assertNodeErrorFree } from "../Utils/generic-util.ts";

let wasmInitialized = false;

/**
 * Default mapping for the legacy `browser[1]` slot — preserved so users on the
 * existing `Browsers.macOS('Chrome')` style get the same `DeviceProps.platformType`
 * they always got. Anything outside this set falls back to `CHROME` (matching
 * the prior bridge behavior). Override with the explicit `deviceProps` config.
 */
const browserToPlatformType = (browser: string): DevicePlatformType => {
	switch (browser) {
		case "Chrome":
			return "CHROME";
		case "Firefox":
			return "FIREFOX";
		case "Safari":
			return "SAFARI";
		case "Edge":
			return "EDGE";
		case "Opera":
			return "OPERA";
		case "Desktop":
			return "DESKTOP";
		case "Android":
			return "ANDROID_PHONE";
		default:
			return "CHROME";
	}
};

/**
 * Returns a no-op `SignalKeyStore`-shaped facade. baileyrs hands this out from
 * `sock.authState.keys` when no legacy `auth.keys` was provided so that
 * upstream-Baileys code paths (typically post-error cleanup like
 * `keys.set({ 'sender-key': { [groupId]: null } })`) don't crash on a missing
 * `.set` method. The Rust bridge owns the real Signal state — this facade is
 * deliberately inert; reads come back empty and writes are dropped after a
 * `debug` log so the call site stays traceable.
 */
function noopKeyStore(logger: ILogger) {
	return {
		get: async () => ({}),
		set: async (data: Record<string, Record<string, unknown> | undefined>) => {
			const types = Object.keys(data).filter(k => data[k]);
			if (types.length) {
				logger.debug(
					{ types },
					"authState.keys.set called — bridge owns Signal state, dropping no-op"
				);
			}
		},
		clear: async () => {
			logger.debug(
				"authState.keys.clear called — no-op (bridge state is not cleared from JS)"
			);
		}
	};
}

function makeSignalRepository(ctx: SocketContext) {
	return {
		decryptMessage: async (opts: {
			jid: string;
			type: "pkmsg" | "msg";
			ciphertext: Uint8Array;
		}) => {
			return (await ctx.getClient()).signalDecryptMessage(
				opts.jid,
				opts.type,
				opts.ciphertext
			);
		},
		encryptMessage: async (opts: {
			jid: string;
			data: Uint8Array;
		}): Promise<{ type: "pkmsg" | "msg"; ciphertext: Uint8Array }> => {
			return (await ctx.getClient()).signalEncryptMessage(opts.jid, opts.data);
		},
		decryptGroupMessage: async (opts: {
			group: string;
			authorJid: string;
			msg: Uint8Array;
		}) => {
			return (await ctx.getClient()).signalDecryptGroupMessage(
				opts.group,
				opts.authorJid,
				opts.msg
			);
		},
		encryptGroupMessage: async (opts: {
			group: string;
			data: Uint8Array;
			meId: string;
		}): Promise<{
			senderKeyDistributionMessage: Uint8Array;
			ciphertext: Uint8Array;
		}> => {
			return (await ctx.getClient()).signalEncryptGroupMessage(
				opts.group,
				opts.data,
				opts.meId
			);
		},
		processSenderKeyDistributionMessage: async (): Promise<void> => {},
		injectE2ESession: async (): Promise<void> => {},
		validateSession: async (
			jid: string
		): Promise<{ exists: boolean; reason?: string }> => {
			const exists = await (await ctx.getClient()).signalValidateSession(jid);
			return { exists };
		},
		jidToSignalProtocolAddress: (jid: string): string => {
			try {
				return ctx.getClientSync().jidToSignalProtocolAddress(jid);
			} catch {
				return `${jid}.0`;
			}
		},
		migrateSession: async (): Promise<{
			migrated: number;
			skipped: number;
			total: number;
		}> => {
			return { migrated: 0, skipped: 0, total: 0 };
		},
		deleteSession: async (jids: string[]): Promise<void> => {
			return (await ctx.getClient()).signalDeleteSessions(jids);
		},
		/**
		 * Bidirectional LID ↔ PN lookup. Mirrors the upstream Baileys
		 * `signalRepository.lidMapping` API.
		 *
		 * Pure passthrough to the bridge — `client.lidForPn` / `client.pnForLid`
		 * delegate to the core's `get_lid_pn_entry`, which is cache-aside as
		 * of whatsapp-rust PR #565: hits the in-memory `lid_pn_cache` first
		 * and falls through to `backend.get_pn_mapping` / `get_lid_mapping`
		 * (so JsStoreCallbacks-backed sessions resolve every persisted
		 * mapping without warm-up needing a list primitive).
		 */
		lidMapping: {
			getLIDForPN: async (pn: string): Promise<string | null> => {
				const client = await ctx.getClient();
				return (await client.lidForPn(pn)) ?? null;
			},
			getPNForLID: async (lid: string): Promise<string | null> => {
				const client = await ctx.getClient();
				return (await client.pnForLid(lid)) ?? null;
			},
			/**
			 * Batch variant of `getLIDForPN`. Upstream Baileys' equivalent
			 * coalesces in-flight requests and de-duplicates inputs; we run
			 * the lookups in parallel and return the same `LIDMapping[]`
			 * shape so callers (e.g. `process-message.ts`) keep working.
			 *
			 * Uses `Promise.allSettled` so one bridge-side failure (e.g.
			 * malformed JID, transient cache miss) doesn't reject the
			 * whole batch and lose every successful lookup. Failures are
			 * logged at debug and skipped.
			 *
			 * Returns `null` (not `[]`) when the input list is empty, to
			 * mirror upstream's "absent" sentinel.
			 */
			getLIDsForPNs: async (pns: string[]): Promise<LIDMapping[] | null> => {
				if (pns.length === 0) return null;
				const client = await ctx.getClient();
				const unique = [...new Set(pns)];
				const settled = await Promise.allSettled(
					unique.map(async pn => {
						const lid = (await client.lidForPn(pn)) ?? null;
						return lid ? ({ pn, lid } satisfies LIDMapping) : null;
					})
				);
				const resolved: LIDMapping[] = [];
				for (const r of settled) {
					if (r.status === "fulfilled") {
						if (r.value) resolved.push(r.value);
					} else {
						ctx.logger.debug(
							{ err: r.reason },
							"getLIDsForPNs: lookup rejected — skipping"
						);
					}
				}
				return resolved;
			},
			getPNsForLIDs: async (lids: string[]): Promise<LIDMapping[] | null> => {
				if (lids.length === 0) return null;
				const client = await ctx.getClient();
				const unique = [...new Set(lids)];
				const settled = await Promise.allSettled(
					unique.map(async lid => {
						const pn = (await client.pnForLid(lid)) ?? null;
						return pn ? ({ pn, lid } satisfies LIDMapping) : null;
					})
				);
				const resolved: LIDMapping[] = [];
				for (const r of settled) {
					if (r.status === "fulfilled") {
						if (r.value) resolved.push(r.value);
					} else {
						ctx.logger.debug(
							{ err: r.reason },
							"getPNsForLIDs: lookup rejected — skipping"
						);
					}
				}
				return resolved;
			},
			/**
			 * No-op shim. The Rust bridge auto-learns LID↔PN mappings inside
			 * `decode_message` / `usync` and persists them through
			 * `JsStoreCallbacks` — upstream Baileys callers (notably
			 * `process-message.ts` re-feeding mappings from `historySync`)
			 * keep type-checking, but we don't need to write back.
			 *
			 * Logs at debug so unexpected paths stay traceable.
			 */
			storeLIDPNMappings: async (pairs: LIDMapping[]): Promise<void> => {
				if (pairs.length === 0) return;
				ctx.logger.debug(
					{ count: pairs.length },
					"lidMapping.storeLIDPNMappings — bridge auto-learns, no-op"
				);
			}
		}
	};
}

function makeWsEmitter(getClient: () => WasmWhatsAppClient | undefined) {
	const ws = new EventEmitter();
	let rawNodeEnabled = false;

	const originalOn = ws.on.bind(ws);
	ws.on = (event: string | symbol, listener: (...args: unknown[]) => void) => {
		if (
			typeof event === "string" &&
			event.startsWith("CB:") &&
			!rawNodeEnabled
		) {
			rawNodeEnabled = true;
			try {
				getClient()?.setRawNodeForwarding(true);
			} catch {}
		}

		return originalOn(event, listener);
	};

	Object.defineProperty(ws, "isOpen", {
		get: () => getClient()?.isConnected() ?? false,
		enumerable: true
	});

	const socketShim = {};
	Object.defineProperty(socketShim, "readyState", {
		get: () => (getClient()?.isConnected() ? 1 : 3),
		enumerable: true
	});
	Object.defineProperty(ws, "socket", {
		value: socketShim,
		enumerable: true,
		configurable: true
	});

	return { ws, isRawNodeEnabled: () => rawNodeEnabled };
}

const makeWASocket = (config: UserFacingSocketConfig) => {
	const fullConfig = { ...DEFAULT_CONNECTION_CONFIG, ...config };
	const { auth, logger } = fullConfig;

	const ev = makeEventBuffer();
	let client: WasmWhatsAppClient | undefined;
	let user: { id?: string; lid?: string } | undefined;

	const { ws, isRawNodeEnabled } = makeWsEmitter(() => client);

	let tagEpoch = 0;

	const tagPrefix = `${randomBytes(6).toString("base64url")}.`;
	const generateMessageTag = () => `${tagPrefix}${tagEpoch++}`;

	let pairedAccount: { platform?: string; businessName?: string } | undefined;
	let cachedAccount: proto.IAdvSignedDeviceIdentity | undefined;

	const ctx: SocketContext = {
		ev,
		logger,
		fullConfig,
		ws,
		getUser: () => user,
		setUser: u => {
			user = u;
		},
		getClient: async () => {
			await initPromise;
			if (initError) {
				throw new Boom(
					"Bridge client failed to initialize: " + initError.message,
					{ statusCode: 500 }
				);
			}

			if (!client)
				throw new Boom("Client not initialized", { statusCode: 500 });
			return client;
		},
		getClientSync: () => {
			if (!client)
				throw new Boom("Client not initialized", { statusCode: 500 });
			return client;
		}
	};

	const handleEvent = makeEventHandler(ctx, {
		onPairSuccess: data => {
			pairedAccount = data;
			client
				?.getAccount?.()
				.then((acc: proto.IAdvSignedDeviceIdentity | undefined) => {
					cachedAccount = acc ?? undefined;
				})
				.catch(() => {});
		}
	});

	const init = async () => {
		if (!wasmInitialized) {
			initWasmEngine(logger, makeCryptoProvider());
			wasmInitialized = true;
		}

		queueMicrotask(() =>
			ev.emit("connection.update", {
				connection: "connecting"
			} as Partial<ConnectionState>)
		);

		let bridgeStore = auth.store ?? null;

		client = await createWhatsAppClient(
			makeTransport(fullConfig),
			makeHttpClient(fullConfig),
			handleEvent,
			bridgeStore,
			fullConfig.cache ?? null,
			fullConfig.version
		);

		_registerActiveBridgeClient(client, logger);

		const [osName, browserName] = fullConfig.browser;

		const deviceOs = browserName === "Android" ? "Android" : osName;
		await client.setDeviceProps({
			os: deviceOs,
			platformType: browserToPlatformType(browserName),
			...fullConfig.deviceProps
		});

		const [jid, lid, account] = await Promise.all([
			client.getJid(),
			client.getLid(),
			client.getAccount().catch(() => undefined)
		]);
		if (jid) {
			user = { id: jid, lid: lid ?? undefined };
		}

		if (account) {
			cachedAccount = account;
		}

		if (browserName === "Android") {
			await client.setClientProfile({ preset: "android", osVersion: osName });
		}

		if (isRawNodeEnabled()) {
			client.setRawNodeForwarding(true);
		}

		const runPromise = client.run() as unknown as Promise<void> | undefined;
		if (runPromise && typeof runPromise.catch === "function") {
			runPromise.catch(err => {
				logger.error({ err }, "bridge client.run() rejected");
				ev.emit("connection.update", {
					connection: "close",
					lastDisconnect: {
						error:
							err instanceof Error
								? err
								: new Boom(String(err), { statusCode: 500 }),
						date: new Date()
					}
				} as Partial<ConnectionState>);
			});
		}
	};

	let initError: Error | undefined;
	const initPromise = init().catch(err => {
		initError = err instanceof Error ? err : new Error(String(err));
		logger.error({ err }, "failed to initialize bridge client");
	});

	const end = async () => {
		const c = client;
		client = undefined;
		if (c) {
			try {
				await c.disconnect();
			} catch {}

			await new Promise(resolve => setImmediate(resolve));
			await new Promise(resolve => setImmediate(resolve));

			let firstFlushError: unknown;
			try {
				await auth.store?.flush?.();
			} catch (e) {
				firstFlushError ??= e;
			}

			try {
				c.free();
			} catch {}

			if (firstFlushError) throw firstFlushError;
		}
	};

	const logout = async (msg?: string) => {
		user = undefined;
		if (client) {
			try {
				await client.logout();
			} catch {}
		}

		ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: {
				error: new Boom(msg || "Logged out", {
					statusCode: DisconnectReason.loggedOut
				}),
				date: new Date()
			}
		} as Partial<ConnectionState>);
		await end();
	};

	const waitForConnectionUpdate = (
		check: (update: Partial<ConnectionState>) => boolean,
		timeoutMs?: number
	) => {
		return new Promise<void>((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined;
			const listener = (update: Partial<ConnectionState>) => {
				if (check(update)) {
					ev.off("connection.update", listener);
					if (timeout) clearTimeout(timeout);
					resolve();
				}
			};

			ev.on("connection.update", listener);
			if (timeoutMs) {
				timeout = setTimeout(() => {
					ev.off("connection.update", listener);
					reject(
						new Boom("Timed out waiting for connection update", {
							statusCode: 408
						})
					);
				}, timeoutMs);

				timeout.unref();
			}
		});
	};

	const sock = {
		ev,
		logger,
		ws,
		type: "md" as const,

		get user(): Contact | undefined {
			if (!user?.id) return undefined;
			return {
				id: user.id,
				lid: user.lid,
				name: pairedAccount?.businessName ?? auth.creds?.me?.name,
				verifiedName: auth.creds?.me?.verifiedName,
				...(auth.creds?.me?.phoneNumber
					? { phoneNumber: auth.creds.me.phoneNumber }
					: {})
			};
		},
		get waClient() {
			return client;
		},
		get isConnected() {
			return client?.isConnected() ?? false;
		},
		get isLoggedIn() {
			return client?.isLoggedIn() ?? false;
		},
		get authState() {
			return {
				creds: {
					...auth.creds,
					me: user ? ({ id: user.id, lid: user.lid } as Contact) : undefined,
					account: cachedAccount,
					platform: pairedAccount?.platform
				},

				keys: auth.keys ?? noopKeyStore(logger)
			};
		},
		generateMessageTag,
		sendNode: async (frame: BinaryNode) => {
			return (await ctx.getClient()).sendNode(frame);
		},
		assertSessions: async (jids: string[], force?: boolean) => {
			return (await ctx.getClient()).assertSessions(jids, force ?? false);
		},
		getUSyncDevices: async (
			jids: string[],
			useCache: boolean,
			ignoreZeroDevices: boolean
		) => {
			return (await ctx.getClient()).getUSyncDevices(
				jids,
				useCache,
				ignoreZeroDevices
			);
		},
		waitForMessage: <T = BinaryNode>(
			msgId: string,
			timeoutMs?: number
		): Promise<T> => {
			return new Promise<T>((resolve, reject) => {
				const timeout = timeoutMs ?? fullConfig.defaultQueryTimeoutMs;
				let timer: NodeJS.Timeout | undefined;
				const tag = `TAG:${msgId}`;

				const onRecv = (data: T) => {
					if (timer) clearTimeout(timer);
					ws.off(tag, listener);
					resolve(data);
				};
				const listener = onRecv as (...args: unknown[]) => void;
				ws.on(tag, listener);
				if (timeout) {
					timer = setTimeout(() => {
						ws.off(tag, listener);
						reject(
							new Boom("Timed out waiting for message", {
								statusCode: DisconnectReason.timedOut
							})
						);
					}, timeout);

					timer.unref();
				}
			});
		},
		query: async (
			node: BinaryNode,
			timeoutMs?: number
		): Promise<BinaryNode> => {
			if (!node.attrs.id) {
				node.attrs.id = generateMessageTag();
			}

			const msgId = node.attrs.id;
			const tag = `TAG:${msgId}`;

			const before = ws.listeners(tag);
			const resultPromise = sock.waitForMessage<BinaryNode>(msgId, timeoutMs);
			try {
				await sock.sendNode(node);
			} catch (err) {
				const ours = ws.listeners(tag).filter(l => !before.includes(l));
				for (const l of ours) ws.off(tag, l as (...args: unknown[]) => void);
				throw err;
			}

			const result = await resultPromise;

			assertNodeErrorFree(result);
			return result;
		},
		sendRawMessage: async (data: Uint8Array | Buffer) => {
			return (await ctx.getClient()).sendRawMessage(
				data instanceof Uint8Array ? data : new Uint8Array(data)
			);
		},
		createParticipantNodes: async (
			jids: string[],
			message: proto.IMessage,
			extraAttrs?: BinaryNode["attrs"]
		): Promise<{
			nodes: BinaryNode[];
			shouldIncludeDeviceIdentity: boolean;
		}> => {
			const bytes = encodeProto("Message", message as Record<string, unknown>);
			return (await ctx.getClient()).createParticipantNodesBytes(
				jids,
				bytes,
				extraAttrs ?? {}
			);
		},
		signalRepository: makeSignalRepository(ctx),

		uploadPreKeys: async () => {},

		uploadPreKeysToServerIfRequired: async () => {},
		end,
		logout,
		waitForConnectionUpdate,
		setAutoReconnect: (enabled: boolean) => {
			client?.setAutoReconnect(enabled);
		},
		/**
		 * Update presence either globally (`available`/`unavailable`) or per-chat
		 * (`composing`/`recording`/`paused`), matching upstream Baileys' overload.
		 * Chat-state updates require `toJid`; omitting it raises `Boom(400)` so the
		 * caller hears about the protocol mistake instead of the bridge silently
		 * sending nothing.
		 */
		sendPresenceUpdate: async (
			presence:
				| "available"
				| "unavailable"
				| "composing"
				| "recording"
				| "paused",
			toJid?: string
		) => {
			const c = await ctx.getClient();
			if (presence === "available" || presence === "unavailable") {
				return c.sendPresence(presence);
			}

			if (!toJid) {
				throw new Boom(
					`sendPresenceUpdate('${presence}') requires a target jid`,
					{ statusCode: 400 }
				);
			}

			return c.sendChatState(toJid, presence);
		},
		/**
		 * Plaintext media upload helper, source-compatible with the upstream
		 * Baileys `sock.waUploadToServer(buf, { mediaType })` shape so existing
		 * callers (or `prepareWAMessageMedia(msg, { upload: sock.waUploadToServer })`)
		 * keep working. Delegates to the bridge's encrypt + CDN-failover upload.
		 */
		waUploadToServer: async (
			data: Uint8Array | Buffer,
			opts: { mediaType: MediaType }
		): Promise<UploadMediaResult> => {
			const bytes =
				data instanceof Uint8Array && !Buffer.isBuffer(data)
					? data
					: new Uint8Array(data);
			return (await ctx.getClient()).uploadMedia(bytes, opts.mediaType);
		},
		fetchPrivacySettings: async () => {
			return (await ctx.getClient()).fetchPrivacySettings();
		},
		updatePrivacySetting: async (category: string, value: string) => {
			await (await ctx.getClient()).updatePrivacySetting(category, value);
		},
		updateLastSeenPrivacy: async (value: string) => {
			await (await ctx.getClient()).updatePrivacySetting("last", value);
		},
		updateOnlinePrivacy: async (value: string) => {
			await (await ctx.getClient()).updatePrivacySetting("online", value);
		},
		updateProfilePicturePrivacy: async (value: string) => {
			await (await ctx.getClient()).updatePrivacySetting("profile", value);
		},
		updateStatusPrivacy: async (value: string) => {
			await (await ctx.getClient()).updatePrivacySetting("status", value);
		},
		updateReadReceiptsPrivacy: async (value: string) => {
			await (await ctx.getClient()).updatePrivacySetting("readreceipts", value);
		},
		updateGroupsAddPrivacy: async (value: string) => {
			await (await ctx.getClient()).updatePrivacySetting("groupadd", value);
		},
		updateDefaultDisappearingMode: async (duration: number) => {
			await (await ctx.getClient()).updateDefaultDisappearingMode(duration);
		},
		rejectCall: async (callId: string, callFrom: string) => {
			await (await ctx.getClient()).rejectCall(callId, callFrom);
		},
		fetchStatus: async (...jids: string[]) => {
			return (await ctx.getClient()).fetchStatus(jids) as Promise<
				Array<{ jid: string; status?: string }>
			>;
		},
		/**
		 * Fetch the account's current reachout-timelock state from the server.
		 *
		 * The same state is also pushed proactively via the
		 * `NotificationUserReachoutTimelockUpdate` MEX notification, which is
		 * surfaced on `connection.update.reachoutTimeLock` automatically. Use
		 * this method to query on demand (e.g. on app start, or after a 463
		 * nack hints that the timelock just kicked in).
		 *
		 * Emits the result on `connection.update.reachoutTimeLock` as a side
		 * effect for parity with the push path. Returns the same state for
		 * callers that prefer awaiting.
		 */
		fetchReachoutTimelock: async (): Promise<ReachoutTimelockState> => {
			const payload = await (await ctx.getClient()).fetchReachoutTimelock();
			const state = mapReachoutTimelock(payload) ?? { isActive: false };
			ev.emit("connection.update", {
				reachoutTimeLock: state
			} as Partial<ConnectionState>);
			return state;
		},
		getBusinessProfile: async (jid: string) => {
			return (await ctx.getClient()).getBusinessProfile(jid);
		},
		fetchMessageHistory: async (
			count: number,
			oldestMsgKey: {
				remoteJid?: string | null;
				id?: string | null;
				fromMe?: boolean | null;
			},
			oldestMsgTimestamp: number
		) => {
			return (await ctx.getClient()).fetchMessageHistory(
				count,
				oldestMsgKey.remoteJid || "",
				oldestMsgKey.id || "",
				oldestMsgKey.fromMe || false,
				oldestMsgTimestamp
			);
		},
		groupMemberAddMode: async (
			jid: string,
			mode: "admin_add" | "all_member_add"
		) => {
			await (await ctx.getClient()).groupMemberAddMode(jid, mode);
		},
		sendStatusMessage: async (
			message: Record<string, unknown>,
			recipients: string[]
		): Promise<string> => {
			const bytes = encodeProto("Message", message);
			return (await ctx.getClient()).sendStatusMessageBytes(bytes, recipients);
		},
		...makeMessageMethods(ctx),
		...makeGroupMethods(ctx),
		...makeContactMethods(ctx),
		...makeProfileMethods(ctx),
		...makeChatActionMethods(ctx),
		...makePresenceMethods(ctx),
		...makeBlockingMethods(ctx),
		...makeNewsletterMethods(ctx),
		downloadMedia: async <T extends "buffer" | "stream">(
			message: WAMessage,
			type: T,
			options: MediaDownloadOptions = {}
		) => {
			return downloadMediaMessage(message, type, options, {
				logger,
				reuploadRequest: (m: WAMessage) => sock.updateMediaMessage(m),
				waClient: await ctx.getClient()
			});
		}
	};

	return sock;
};

export default makeWASocket;
