/**
 * Canonical → Baileys event dispatcher.
 *
 * `adaptBridgeEvent` (Bridge/schema.ts) yields a `CanonicalEvent`
 * discriminated union; `DISPATCHERS` is a `{ [K in CanonicalEvent['type']]: … }`
 * mapped type so TS forces a handler per variant — a missing handler
 * is a compile error.
 */

import type { WhatsAppEvent } from "whatsapp-rust-bridge";
import type { CanonicalEvent, CanonicalMessage } from "../Bridge/index.ts";
import { adaptBridgeEvent } from "../Bridge/index.ts";
import type {
	BaileysEventMap,
	BinaryNode,
	ConnectionState,
	WACallEvent,
	WACallUpdateType,
	WAMessage,
	WAPresence
} from "../Types/index.ts";
import { DisconnectReason, WAProto } from "../Types/index.ts";
import { Boom } from "../Utils/boom.ts";
import {
	buildGroupJoinRequestEvents,
	buildGroupNotificationDomainEvent,
	buildGroupNotificationStubMessages
} from "./group-notifications.ts";
import { mapReachoutTimelock } from "./reachout.ts";
import type { SocketContext } from "./types.ts";
import { isJidGroup } from "../Utils/jid-utils.ts";

const DEF_CALLBACK_PREFIX = "CB:";
const DEF_TAG_PREFIX = "TAG:";

const emitCBEvents = (ctx: SocketContext, node: BinaryNode) => {
	const { ws } = ctx;
	const l0 = node.tag;
	const l1 = node.attrs || {};
	const l2 = Array.isArray(node.content)
		? (node.content[0] as BinaryNode)?.tag
		: "";

	const id = l1.id;
	if (id) ws.emit(`${DEF_TAG_PREFIX}${id}`, node);

	for (const [key, val] of Object.entries(l1)) {
		if (l2) ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${val},${l2}`, node);
		ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${val}`, node);

		ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, node);
	}
	if (l2) ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, node);
	ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, node);
};

/**
 * Build a Baileys `WAMessage` from a canonical message.
 *
 * Lives at this layer (not in the adapter) because `WAProto.WebMessageInfo`
 * is the Baileys upstream contract — it's the OUTBOUND end of the
 * bridge → canonical → Baileys pipeline. Adapters never reach for the proto.
 */
const canonicalMessageToWAMessage = (m: CanonicalMessage): WAMessage => {
	const wm = WAProto.WebMessageInfo.fromObject({
		key: {
			remoteJid: m.chatJid,
			fromMe: m.isFromMe,
			id: m.id,
			participant: m.senderJid
		},
		message: m.messageProto,
		messageTimestamp: m.timestamp,
		pushName: m.pushName,
		status: WAProto.WebMessageInfo.Status.SERVER_ACK
	}) as WAMessage;
	if (m.participantAlt) wm.key.participantAlt = m.participantAlt;
	if (m.remoteJidAlt) wm.key.remoteJidAlt = m.remoteJidAlt;
	if (m.isViewOnce) wm.key.isViewOnce = true;

	if (m.editAttribute)
		(wm.key as { editAttribute?: string }).editAttribute = m.editAttribute;
	return wm;
};

interface EventCallbacks {
	onPairSuccess?: (data: {
		platform?: string;
		businessName?: string;
	}) => void | Promise<void>;
}

interface DispatchCtx {
	ctx: SocketContext;
	callbacks?: EventCallbacks;
}

type CanonicalByType<T extends CanonicalEvent["type"]> = Extract<
	CanonicalEvent,
	{ type: T }
>;

type DispatcherFn<T extends CanonicalEvent["type"]> = (
	evt: CanonicalByType<T>,
	dispatch: DispatchCtx
) => void;

/**
 * Mapped type forces every CanonicalEvent variant to have an entry. Adding
 * a new variant to `CanonicalEvent` and forgetting a handler here is a
 * compile error — no `assertNever` runtime hack required.
 */
type DispatcherMap = { [K in CanonicalEvent["type"]]: DispatcherFn<K> };

const emitClose = (
	ctx: SocketContext,
	reason: string,
	statusCode: number,
	data?: Record<string, unknown>
) =>
	ctx.ev.emit("connection.update", {
		connection: "close",
		lastDisconnect: {
			error: new Boom(reason, { statusCode, data }),
			date: new Date()
		}
	} as Partial<ConnectionState>);

/**
 * Map bridge `ConnectFailureReason` wire codes (per the bridge's
 * `.d.ts` annotation) onto upstream Baileys' `DisconnectReason`.
 * Unknown codes fall through to `connectionClosed` so existing
 * reconnect heuristics keep working.
 */
const mapConnectFailureToDisconnect = (reason: number | undefined): number => {
	switch (reason) {
		case 401:
		case 403:
		case 406:
			return DisconnectReason.loggedOut;
		case 402:
			return DisconnectReason.forbidden;
		case 405:
			return DisconnectReason.badSession;
		case 503:
		case 501:
			return DisconnectReason.unavailableService;
		case 408:
			return DisconnectReason.timedOut;
		case 515:
			return DisconnectReason.restartRequired;

		default:
			return DisconnectReason.connectionClosed;
	}
};

const describeTempBan = (code: number | undefined): string => {
	switch (code) {
		case 101:
			return "sent_to_too_many_people";
		case 102:
			return "blocked_by_users";
		case 103:
			return "created_too_many_groups";
		case 104:
			return "sent_too_many_same_message";
		case 106:
			return "broadcast_list";
		default:
			return code != null ? `code_${code}` : "unknown";
	}
};

/**
 * Sole `as` cast in the dispatch path. The bridge runtime's
 * `connection.update` slot accepts the full ConnectionState union, but we
 * only ever emit partials shaped as `{ connection, … }`. The Baileys event
 * map types `connection.update` as the full state which is unsafe to
 * widen; centralizing the cast here keeps every dispatcher clean.
 */
const emitConnectionUpdate = (
	ctx: SocketContext,
	update: Partial<ConnectionState>
) => ctx.ev.emit("connection.update", update as Partial<ConnectionState>);

const DISPATCHERS: DispatcherMap = {
	connected: (_, { ctx }) => emitConnectionUpdate(ctx, { connection: "open" }),
	disconnected: (_, { ctx }) =>
		emitClose(ctx, "Connection closed", DisconnectReason.connectionClosed),
	qr: (evt, { ctx }) => emitConnectionUpdate(ctx, { qr: evt.code }),
	pairSuccess: (evt, { ctx, callbacks }) => {
		const { id, lid, businessName, platform } = evt;
		ctx.setUser({ id, lid });
		callbacks?.onPairSuccess?.({ platform, businessName });

		ctx.ev.emit("creds.update", {
			registered: true,
			me: { id, lid, name: businessName },
			platform
		});
	},
	pairError: (evt, { ctx }) =>
		emitClose(
			ctx,
			"Pairing failed: " + evt.error,
			DisconnectReason.connectionClosed
		),
	loggedOut: (evt, { ctx }) =>
		emitClose(
			ctx,
			evt.reason ? `Logged out: ${evt.reason}` : "Logged out",
			DisconnectReason.loggedOut
		),
	connectFailure: (evt, { ctx }) => {
		const status = mapConnectFailureToDisconnect(evt.reason);
		emitClose(ctx, evt.message ?? "Connection failure", status);
	},

	streamError: (evt, { ctx }) =>
		emitClose(ctx, "Stream error: " + evt.code, DisconnectReason.badSession, {
			streamErrorCode: evt.code
		}),
	streamReplaced: (_, { ctx }) =>
		emitConnectionUpdate(ctx, {
			connection: "close",
			lastDisconnect: {
				error: new Boom("Connection replaced", {
					statusCode: DisconnectReason.connectionReplaced
				}),
				date: new Date()
			}
		}),
	clientOutdated: (_, { ctx }) =>
		emitClose(ctx, "Client outdated", DisconnectReason.badSession),
	temporaryBan: (evt, { ctx }) => {
		const reason = describeTempBan(evt.code);
		const message = evt.expire
			? `Temporary ban (${reason}); expires at ${new Date(evt.expire * 1000).toISOString()}`
			: `Temporary ban (${reason})`;
		ctx.ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: {
				error: new Boom(message, {
					statusCode: DisconnectReason.forbidden,
					data: { code: evt.code, expire: evt.expire }
				}),
				date: new Date()
			}
		} as Partial<ConnectionState>);
	},
	qrScannedWithoutMultidevice: (_, { ctx }) =>
		ctx.logger.warn("QR scanned but multi-device not enabled on phone"),

	message: (evt, { ctx }) => {
		if (ctx.fullConfig.shouldIgnoreJid?.(evt.chatJid)) return;

		const waMsg = canonicalMessageToWAMessage(evt);
		const upsertPayload: BaileysEventMap["messages.upsert"] = {
			messages: [waMsg],
			type: evt.isOffline ? "append" : "notify"
		};
		if (evt.unavailableRequestId)
			upsertPayload.requestId = evt.unavailableRequestId;
		ctx.ev.emit("messages.upsert", upsertPayload);

		const reactionMessage = evt.messageProto.reactionMessage;
		if (reactionMessage?.key) {
			ctx.ev.emit("messages.reaction", [
				{
					key: reactionMessage.key,
					reaction: { ...reactionMessage, key: waMsg.key }
				}
			]);
		}

		const protocolMsg = evt.messageProto.protocolMessage;

		if (
			protocolMsg?.type ===
				WAProto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE &&
			protocolMsg.memberLabel?.label
		) {
			if (!evt.senderJid) {
				ctx.logger.warn(
					{ chatJid: evt.chatJid, label: protocolMsg.memberLabel.label },
					"GROUP_MEMBER_LABEL_CHANGE without senderJid — dropping (no participant to attribute)"
				);
			} else {
				ctx.ev.emit("group.member-tag.update", {
					groupId: evt.chatJid,
					label: protocolMsg.memberLabel.label,
					participant: evt.senderJid,
					participantAlt: evt.participantAlt,
					messageTimestamp: evt.timestamp
				});
			}
		}

		const protocolKeyId = protocolMsg?.key?.id;
		if (protocolMsg && protocolKeyId) {
			if (protocolMsg.type === WAProto.Message.ProtocolMessage.Type.REVOKE) {
				ctx.ev.emit("messages.update", [
					{
						key: { ...waMsg.key, id: protocolKeyId },
						update: {
							message: null,
							messageStubType: WAProto.WebMessageInfo.StubType.REVOKE,
							key: waMsg.key
						}
					}
				]);
			} else if (
				protocolMsg.type ===
					WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
				protocolMsg.editedMessage
			) {
				const tsMs = protocolMsg.timestampMs;
				const editedTs =
					tsMs != null
						? Math.floor(Number(tsMs) / 1000)
						: (evt.timestamp ?? waMsg.messageTimestamp);
				ctx.ev.emit("messages.update", [
					{
						key: { ...waMsg.key, id: protocolKeyId },
						update: {
							message: {
								editedMessage: { message: protocolMsg.editedMessage }
							},
							messageTimestamp: editedTs
						}
					}
				]);
			}
		}
	},

	receipt: (evt, { ctx }) => {
		const participant = evt.isGroup ? evt.senderJid : undefined;
		const receipt: {
			receiptTimestamp?: number;
			readTimestamp?: number;
			playedTimestamp?: number;
		} = {};
		if (evt.receiptType === "read" || evt.receiptType === "read-self") {
			receipt.readTimestamp = evt.timestamp;
		} else if (
			evt.receiptType === "played" ||
			evt.receiptType === "played-self"
		) {
			receipt.playedTimestamp = evt.timestamp;
		} else {
			receipt.receiptTimestamp = evt.timestamp;
		}
		ctx.ev.emit(
			"message-receipt.update",
			evt.messageIds.map(id => ({
				key: { remoteJid: evt.chatJid, id, fromMe: evt.isFromMe, participant },
				receipt
			}))
		);
	},

	undecryptableMessage: (evt, { ctx }) => {
		ctx.logger.debug(
			{
				id: evt.id,
				chat: evt.chatJid,
				isUnavailable: evt.isUnavailable,
				fail: evt.decryptFailMode
			},
			"undecryptable message received"
		);

		if (evt.decryptFailMode === "hide") return;
		const stubMsg = WAProto.WebMessageInfo.fromObject({
			key: {
				remoteJid: evt.chatJid,
				fromMe: evt.isFromMe,
				id: evt.id,
				participant: evt.senderJid
			},
			messageTimestamp: evt.timestamp,
			pushName: evt.pushName,
			messageStubType: WAProto.WebMessageInfo.StubType.CIPHERTEXT,
			messageStubParameters: evt.unavailableType ? [evt.unavailableType] : []
		}) as WAMessage;
		if (evt.participantAlt) stubMsg.key.participantAlt = evt.participantAlt;
		if (evt.remoteJidAlt) stubMsg.key.remoteJidAlt = evt.remoteJidAlt;
		ctx.ev.emit("messages.upsert", { messages: [stubMsg], type: "notify" });
	},

	pushNameUpdate: (evt, { ctx }) =>
		ctx.ev.emit("contacts.update", [{ id: evt.jid, notify: evt.newPushName }]),
	contactUpdate: (evt, { ctx }) => {
		const update: {
			id: string;
			name?: string;
			lid?: string;
			phoneNumber?: string;
		} = { id: evt.jid };
		const name = evt.fullName ?? evt.firstName;
		if (name) update.name = name;
		if (evt.lidJid) update.lid = evt.lidJid;
		if (evt.pnJid) update.phoneNumber = evt.pnJid;
		ctx.ev.emit("contacts.update", [update]);
	},
	pictureUpdate: (evt, { ctx }) =>
		ctx.ev.emit("contacts.update", [
			{ id: evt.jid, imgUrl: evt.removed ? null : "changed" }
		]),

	presence: (evt, { ctx }) =>
		ctx.ev.emit("presence.update", {
			id: evt.from,
			presences: {
				[evt.from]: {
					lastKnownPresence: (evt.unavailable
						? "unavailable"
						: "available") as WAPresence,
					lastSeen: evt.lastSeen
				}
			}
		}),
	chatPresence: (evt, { ctx }) => {
		let mapped: WAPresence;
		if (evt.state === "composing")
			mapped = evt.media === "audio" ? "recording" : "composing";
		else if (evt.state === "paused") mapped = "paused";
		else {
			ctx.logger.debug(
				{ state: evt.state, media: evt.media },
				"chat_presence: unknown state — falling back to paused"
			);
			mapped = "paused";
		}
		ctx.ev.emit("presence.update", {
			id: evt.chatJid,
			presences: { [evt.senderJid]: { lastKnownPresence: mapped } }
		});
	},

	groupUpdate: (evt, { ctx }) => {
		const user = ctx.getUser();
		const fromMe = !!(
			evt.author &&
			(evt.author === user?.id || evt.author === user?.lid)
		);

		const domainEvent = buildGroupNotificationDomainEvent(evt);
		if (domainEvent) {
			if (domainEvent.name === "groups.update")
				ctx.ev.emit("groups.update", domainEvent.payload);
			else ctx.ev.emit("group-participants.update", domainEvent.payload);
		}

		for (const joinReq of buildGroupJoinRequestEvents(evt)) {
			ctx.ev.emit("group.join-request", joinReq);
		}

		const stubMessages = buildGroupNotificationStubMessages(evt, fromMe);
		if (stubMessages.length > 0) {
			ctx.ev.emit("messages.upsert", {
				messages: stubMessages,
				type: "notify"
			} as BaileysEventMap["messages.upsert"]);
		}
	},

	archiveUpdate: (evt, { ctx }) =>
		ctx.ev.emit("chats.update", [{ id: evt.jid, archived: evt.archived }]),
	pinUpdate: (evt, { ctx }) =>
		ctx.ev.emit("chats.update", [
			{ id: evt.jid, pinned: evt.pinned ? evt.timestamp : null }
		]),
	muteUpdate: (evt, { ctx }) =>
		ctx.ev.emit("chats.update", [
			{
				id: evt.jid,
				muteEndTime: evt.muted ? (evt.muteEndTimestamp ?? 0) : null
			}
		]),
	starUpdate: (evt, { ctx }) =>
		ctx.ev.emit("messages.update", [
			{
				key: {
					remoteJid: evt.chatJid,
					id: evt.messageId,
					fromMe: evt.fromMe,
					participant: evt.participantJid
				},
				update: { starred: evt.starred }
			}
		]),
	markChatAsReadUpdate: (evt, { ctx }) =>
		ctx.ev.emit("chats.update", [
			{ id: evt.jid, unreadCount: evt.read ? 0 : -1 }
		]),

	incomingCall: (evt, { ctx }) => {
		const isGroup = isJidGroup(evt.from);

		const status: WACallUpdateType =
			evt.action.type === "preAccept"
				? "ringing"
				: (evt.action.type as WACallUpdateType);
		const callEvt: WACallEvent = {
			chatId: evt.from,
			from: evt.from,
			id: evt.action.callId,
			date: new Date(evt.timestamp * 1000),
			status,
			offline: evt.offline,
			isGroup,

			...(isGroup ? { groupJid: evt.from } : {}),
			...(evt.action.callerPn ? { callerPn: evt.action.callerPn } : {}),
			...(evt.action.type === "offer" ? { isVideo: !!evt.action.isVideo } : {}),

			...(evt.action.callerCountryCode
				? { callerCountryCode: evt.action.callerCountryCode }
				: {}),
			...(evt.action.deviceClass
				? { deviceClass: evt.action.deviceClass }
				: {}),
			...(evt.action.joinable !== undefined
				? { joinable: evt.action.joinable }
				: {}),
			...(evt.action.audio ? { audio: evt.action.audio } : {}),
			...(evt.action.duration !== undefined
				? { duration: evt.action.duration }
				: {}),
			...(evt.action.audioDuration !== undefined
				? { audioDuration: evt.action.audioDuration }
				: {}),
			...(evt.stanzaId ? { stanzaId: evt.stanzaId } : {}),
			...(evt.notify ? { notify: evt.notify } : {}),
			...(evt.platform ? { platform: evt.platform } : {}),
			...(evt.version ? { version: evt.version } : {})
		};
		ctx.ev.emit("call", [callEvt]);
	},

	rawNode: (evt, { ctx }) => emitCBEvents(ctx, evt.node),
	notification: (evt, { ctx }) =>
		ctx.logger.trace(
			{ tag: evt.tag, attrs: evt.attrs },
			"bridge generic notification (no Baileys mapping)"
		),
	mexNotification: (evt, { ctx }) => {
		if (evt.opName === "NotificationUserReachoutTimelockUpdate") {
			const state = mapReachoutTimelock(evt.payload);
			if (state) emitConnectionUpdate(ctx, { reachoutTimeLock: state });
			else
				ctx.logger.warn(
					{ payload: evt.payload },
					"reachout-timelock push: payload missing expected fields"
				);
			return;
		}
		ctx.logger.trace(
			{ opName: evt.opName, offline: evt.offline },
			"bridge mex notification with no Baileys mapping (drop)"
		);
	},
	noop: (evt, { ctx }) =>
		ctx.logger.trace(
			{ bridgeType: evt.bridgeType, detail: evt.detail },
			"bridge event acknowledged (no Baileys equivalent)"
		),

	lidMappingUpdate: (evt, { ctx }) => {
		for (const mapping of evt.mappings) {
			ctx.ev.emit("lid-mapping.update", mapping);
		}
	},
	chatDelete: (evt, { ctx }) => ctx.ev.emit("chats.delete", [evt.jid]),
	messageDelete: (evt, { ctx }) =>
		ctx.ev.emit("messages.delete", {
			keys: [
				{
					remoteJid: evt.chatJid,
					id: evt.messageId,
					fromMe: evt.fromMe,
					...(evt.participantJid ? { participant: evt.participantJid } : {})
				}
			]
		}),
	newsletterLiveUpdate: (evt, { ctx }) => {
		for (const msg of evt.messages) {
			for (const reaction of msg.reactions) {
				ctx.ev.emit("newsletter.reaction", {
					id: evt.newsletterJid,
					server_id: msg.serverId,
					reaction: {
						code: reaction.code,
						count: reaction.count,
						removed: reaction.count === 0
					}
				});
			}
		}
	},
	disappearingModeChanged: (evt, { ctx }) =>
		ctx.ev.emit("chats.update", [
			{
				id: evt.jid,
				ephemeralExpiration: evt.duration > 0 ? evt.duration : null,
				ephemeralSettingTimestamp: evt.settingTimestamp
			}
		]),

	historySync: (evt, { ctx }) => {
		const HSType = WAProto.HistorySync.HistorySyncType;
		const isInitial = evt.syncType === HSType.INITIAL_BOOTSTRAP;
		const payload: BaileysEventMap["messaging-history.set"] = {
			chats: evt.chats,
			contacts: evt.contacts,
			messages: evt.messages,
			isLatest: evt.syncType === HSType.ON_DEMAND ? undefined : isInitial,
			progress: evt.progress,
			syncType: evt.syncType,
			chunkOrder: evt.chunkOrder,
			peerDataRequestSessionId: evt.peerDataRequestSessionId,
			lidPnMappings:
				evt.lidPnMappings.length > 0 ? evt.lidPnMappings : undefined
		};
		ctx.ev.emit("messaging-history.set", payload);

		if (evt.chats.length > 0) ctx.ev.emit("chats.upsert", evt.chats);
		if (evt.contacts.length > 0) ctx.ev.emit("contacts.upsert", evt.contacts);
	}
};

/**
 * Create the event handler that translates canonical events into Baileys
 * events on `ctx.ev`. The handler does NO bridge-shape inspection — that's
 * the schema's job. Field-access here references canonical types
 * exclusively, so a downstream rename surfaces as a `tsc` failure.
 */
export const makeEventHandler = (
	ctx: SocketContext,
	callbacks?: EventCallbacks
) => {
	const dispatchCtx: DispatchCtx = { ctx, callbacks };

	return (event: WhatsAppEvent) => {
		const canonical = adaptBridgeEvent(event, ctx.logger);
		if (!canonical) return;

		const dispatcher = DISPATCHERS[canonical.type] as DispatcherFn<
			typeof canonical.type
		>;
		try {
			dispatcher(canonical, dispatchCtx);
		} catch (err) {
			ctx.logger.error(
				{ err, type: canonical.type },
				"dispatcher threw — dropping event"
			);
		}
	};
};
