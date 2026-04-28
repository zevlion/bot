import type { WhatsAppEvent } from "whatsapp-rust-bridge";
import type { CanonicalEvent, CanonicalMessage } from "../Bridge/index.ts";
import type {
  BaileysEventMap,
  BinaryNode,
  ConnectionState,
  WACallEvent,
  WACallUpdateType,
  WAMessage,
  WAPresence,
} from "../Types/index.ts";
import { adaptBridgeEvent } from "../Bridge/index.ts";
import { DisconnectReason, WAProto } from "../Types/index.ts";
import { Boom } from "../Utils/boom.ts";
import { isJidGroup } from "../Utils/jid-utils.ts";
import {
  buildGroupNotificationDomainEvent,
  buildGroupNotificationStubMessages,
} from "./group-notifications.ts";
import { mapReachoutTimelock } from "./reachout.ts";
import type { SocketContext } from "./types.ts";

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
  }
  if (l2) ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, node);
  ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, node);
};

/**
 * Build a `WAMessage` from a canonical message.
 * bridge → canonical → pipeline. Adapters never reach for the proto.
 */
const canonicalMessageToWAMessage = (m: CanonicalMessage): WAMessage => {
  const wm = WAProto.WebMessageInfo.fromObject({
    key: {
      remoteJid: m.chatJid,
      fromMe: m.isFromMe,
      id: m.id,
      participant: m.senderJid,
    },
    message: m.messageProto,
    messageTimestamp: m.timestamp,
    pushName: m.pushName,
    status: WAProto.WebMessageInfo.Status.SERVER_ACK,
  }) as WAMessage;
  if (m.participantAlt) wm.key.participantAlt = m.participantAlt;
  if (m.remoteJidAlt) wm.key.remoteJidAlt = m.remoteJidAlt;
  return wm;
};

export const makeEventHandler = (
  ctx: SocketContext,
  callbacks?: {
    onPairSuccess?: (data: {
      platform?: string;
      businessName?: string;
    }) => void;
  },
) => {
  const { ev } = ctx;

  const emitClose = (reason: string, statusCode: number) =>
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: new Boom(reason, { statusCode }),
        date: new Date(),
      },
    } as Partial<ConnectionState>);

  const dispatch = (evt: CanonicalEvent) => {
    switch (evt.type) {
      case "connected":
        ev.emit("connection.update", {
          connection: "open",
        } as Partial<ConnectionState>);
        return;

      case "disconnected":
        emitClose("Connection closed", DisconnectReason.connectionClosed);
        return;

      case "qr":
        ev.emit("connection.update", {
          qr: evt.code,
        } as Partial<ConnectionState>);
        return;

      case "pairSuccess": {
        const { id, lid, businessName, platform } = evt;
        ctx.setUser({ id, lid });
        callbacks?.onPairSuccess?.({ platform, businessName });
        // Synthetic `creds.update` so upstream-style auth code
        // (`ev.on('creds.update', saveCreds)` /
        // `eventManager.register(...)`) gets a single tick to persist
        // its post-pair state. The bridge owns the real creds.
        ev.emit("creds.update", {
          registered: true,
          me: { id, lid, name: businessName },
          platform,
        });
        return;
      }

      case "pairError":
        emitClose(
          "Pairing failed: " + evt.error,
          DisconnectReason.connectionClosed,
        );
        return;

      case "loggedOut":
        emitClose("Logged out", DisconnectReason.loggedOut);
        return;

      case "connectFailure":
        emitClose(
          evt.message ?? "Connection failure",
          DisconnectReason.connectionClosed,
        );
        return;

      case "streamError":
        emitClose("Stream error: " + evt.code, DisconnectReason.badSession);
        return;

      case "streamReplaced":
        ev.emit("connection.update", {
          connection: "close",
          lastDisconnect: {
            error: new Boom("Connection replaced", {
              statusCode: DisconnectReason.connectionReplaced,
            }),
            date: new Date(),
          },
        } as Partial<ConnectionState>);
        return;

      case "clientOutdated":
        emitClose("Client outdated", DisconnectReason.badSession);
        return;

      case "temporaryBan":
        emitClose("Temporary ban", DisconnectReason.forbidden);
        return;

      case "qrScannedWithoutMultidevice":
        ctx.logger?.warn("QR scanned but multi-device not enabled on phone");
        return;

      case "message": {
        if (ctx.fullConfig.shouldIgnoreJid?.(evt.chatJid)) return;
        // Note: `emitOwnEvents=false` is NOT applied here.
        // messages from other linked devices.
        const waMsg = canonicalMessageToWAMessage(evt);
        ev.emit("messages.upsert", {
          messages: [waMsg],
          type: "notify",
        } as BaileysEventMap["messages.upsert"]);
        return;
      }

      case "receipt": {
        ev.emit("message-receipt.update", [
          {
            key: {
              remoteJid: evt.chatJid,
              id: evt.messageIds[0]!,
              fromMe: evt.isFromMe,
              participant: evt.isGroup ? evt.senderJid : undefined,
            },
            receipt: { receiptTimestamp: evt.timestamp },
          },
        ]);
        return;
      }

      case "undecryptableMessage":
        ctx.logger?.warn({ event: evt.raw }, "undecryptable message received");
        return;

      case "pushNameUpdate":
        ev.emit("contacts.update", [{ id: evt.jid, notify: evt.newPushName }]);
        return;

      case "contactUpdate":
        ev.emit("contacts.update", [{ id: evt.jid }]);
        return;

      case "pictureUpdate":
        ev.emit("contacts.update", [{ id: evt.jid, imgUrl: "changed" }]);
        return;

      case "presence":
        ev.emit("presence.update", {
          id: evt.from,
          presences: {
            [evt.from]: {
              lastKnownPresence: (evt.unavailable
                ? "unavailable"
                : "available") as WAPresence,
              lastSeen: evt.lastSeen,
            },
          },
        });
        return;

      case "chatPresence":
        ev.emit("presence.update", {
          id: evt.chatJid,
          presences: {
            [evt.senderJid]: { lastKnownPresence: evt.state as WAPresence },
          },
        });
        return;

      case "groupUpdate": {
        const user = ctx.getUser();
        const fromMe = !!(
          evt.author &&
          (evt.author === user?.id || evt.author === user?.lid)
        );

        const domainEvent = buildGroupNotificationDomainEvent(evt);
        if (domainEvent)
          ev.emit(domainEvent.name, domainEvent.payload as never);

        const stubMessages = buildGroupNotificationStubMessages(evt, fromMe);
        if (stubMessages.length > 0) {
          ev.emit("messages.upsert", {
            messages: stubMessages,
            type: "notify",
          } as BaileysEventMap["messages.upsert"]);
        }
        return;
      }

      case "archiveUpdate":
        ev.emit("chats.update", [{ id: evt.jid, archived: true }]);
        return;

      case "pinUpdate":
        ev.emit("chats.update", [{ id: evt.jid, pinned: evt.timestamp }]);
        return;

      case "muteUpdate":
        ev.emit("chats.update", [{ id: evt.jid, muteEndTime: evt.timestamp }]);
        return;

      case "starUpdate":
        ev.emit("messages.update", [
          {
            key: {
              remoteJid: evt.chatJid,
              id: evt.messageId,
              fromMe: evt.fromMe,
              participant: evt.participantJid,
            },
            update: { starred: evt.starred },
          },
        ]);
        return;

      case "markChatAsReadUpdate":
        ev.emit("chats.update", [{ id: evt.jid, unreadCount: 0 }]);
        return;

      case "incomingCall": {
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
          ...(evt.action.type === "offer" && evt.action.callerPn
            ? { callerPn: evt.action.callerPn }
            : {}),
          ...(evt.action.type === "offer"
            ? { isVideo: !!evt.action.isVideo }
            : {}),
        };
        ev.emit("call", [callEvt]);
        return;
      }

      case "rawNode":
        emitCBEvents(ctx, evt.node);
        return;

      case "notification":
        ctx.logger?.trace(
          { tag: evt.tag, attrs: evt.attrs },
          "bridge generic notification (no Baileys mapping)",
        );
        return;

      case "mexNotification": {
        // Route by op_name. Adding a new MEX-driven event means a new
        // case here — no per-op_name plumbing in the Bridge layer.
        if (evt.opName === "NotificationUserReachoutTimelockUpdate") {
          const state = mapReachoutTimelock(evt.payload);
          if (state) {
            ev.emit("connection.update", {
              reachoutTimeLock: state,
            } as Partial<ConnectionState>);
          } else {
            ctx.logger?.warn(
              { payload: evt.payload },
              "reachout-timelock push: payload missing expected fields",
            );
          }
          return;
        }
        ctx.logger?.trace(
          { opName: evt.opName, offline: evt.offline },
          "bridge mex notification with no Baileys mapping (drop)",
        );
        return;
      }

      case "noop":
        ctx.logger?.trace(
          { bridgeType: evt.bridgeType, detail: evt.detail },
          "bridge event acknowledged (no Baileys equivalent)",
        );
        return;
    }
  };

  return (event: WhatsAppEvent) => {
    const canonical = adaptBridgeEvent(event, ctx.logger);
    if (!canonical) return;
    dispatch(canonical);
  };
};
