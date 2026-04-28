import { proto } from "whatsapp-rust-bridge/proto-types";
import type { Boom } from "../Utils/boom.ts";
import type { AuthenticationCreds, LIDMapping } from "./Auth.ts";
import type { WACallEvent } from "./Call.ts";
import type { Chat, ChatUpdate, PresenceData } from "./Chat.ts";
import type { Contact } from "./Contact.ts";
import type {
  GroupMetadata,
  GroupParticipant,
  ParticipantAction,
  RequestJoinAction,
  RequestJoinMethod,
} from "./GroupMetadata.ts";
import type { Label } from "./Label.ts";
import type { LabelAssociation } from "./LabelAssociation.ts";
import type {
  MessageUpsertType,
  MessageUserReceiptUpdate,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
} from "./Message.ts";
import type { ConnectionState } from "./State.ts";

export type BaileysEventMap = {
  
  "connection.update": Partial<ConnectionState>;
  
  "creds.update": Partial<AuthenticationCreds>;
  
  "messaging-history.set": {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings?: LIDMapping[];
    isLatest?: boolean;
    progress?: number | null;
    syncType?: proto.HistorySync.HistorySyncType | null;
    peerDataRequestSessionId?: string | null;
  };
  
  "chats.upsert": Chat[];
  
  "chats.update": ChatUpdate[];
  "lid-mapping.update": LIDMapping;
  
  "chats.delete": string[];
  
  "presence.update": {
    id: string;
    presences: { [participant: string]: PresenceData };
  };

  "contacts.upsert": Contact[];
  "contacts.update": Partial<Contact>[];

  "messages.delete": { keys: WAMessageKey[] } | { jid: string; all: true };
  "messages.update": WAMessageUpdate[];
  "messages.media-update": {
    key: WAMessageKey;
    media?: { ciphertext: Uint8Array; iv: Uint8Array };
    error?: Boom;
  }[];
  /**
   * add/update the given messages. If they were received while the connection was online,
   * the update will have type: "notify"
   * if requestId is provided, then the messages was received from the phone due to it being unavailable
   *  */
  "messages.upsert": {
    messages: WAMessage[];
    type: MessageUpsertType;
    requestId?: string;
  };
  
  "messages.reaction": { key: WAMessageKey; reaction: proto.IReaction }[];

  "message-receipt.update": MessageUserReceiptUpdate[];

  "groups.upsert": GroupMetadata[];
  "groups.update": Partial<GroupMetadata>[];
  /**
   * Participant change in a group.
   *
   * `participants` is `GroupParticipant[]` — matches upstream Baileys exactly
   * (`@whiskeysockets/baileys` declares the same shape). Each entry has at
   * least `id` (the participant JID); `admin` is populated for promote/demote
   * actions where the new role is unambiguous from the action itself.
   * Use `action` to interpret the change (add/remove/promote/demote/modify).
   */
  "group-participants.update": {
    id: string;
    author: string;
    
    authorPn?: string;
    participants: GroupParticipant[];
    action: ParticipantAction;
  };
  "group.join-request": {
    id: string;
    author: string;
    authorPn?: string;
    participant: string;
    participantPn?: string;
    action: RequestJoinAction;
    method: RequestJoinMethod;
  };
  
  "group.member-tag.update": {
    groupId: string;
    participant: string;
    participantAlt?: string;
    label: string;
    messageTimestamp?: number;
  };

  "blocklist.set": { blocklist: string[] };
  "blocklist.update": { blocklist: string[]; type: "add" | "remove" };

  
  call: WACallEvent[];
  "labels.edit": Label;
  "labels.association": {
    association: LabelAssociation;
    type: "add" | "remove";
  };

  
  "newsletter.reaction": {
    id: string;
    server_id: string;
    reaction: { code?: string; count?: number; removed?: boolean };
  };
  "newsletter.view": { id: string; server_id: string; count: number };
  "newsletter-participants.update": {
    id: string;
    author: string;
    user: string;
    new_role: string;
    action: string;
  };
  "newsletter-settings.update": { id: string; update: Record<string, unknown> };

  
  "chats.lock": { id: string; locked: boolean };
  "settings.update":
    | { setting: "unarchiveChats"; value: boolean }
    | { setting: "locale"; value: string }
    | {
        setting: "disableLinkPreviews";
        value: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction;
      }
    | { setting: "timeFormat"; value: proto.SyncActionValue.ITimeFormatAction }
    | {
        setting: "privacySettingRelayAllCalls";
        value: proto.SyncActionValue.IPrivacySettingRelayAllCalls;
      }
    | {
        setting: "statusPrivacy";
        value: proto.SyncActionValue.IStatusPrivacyAction;
      }
    | {
        setting: "notificationActivitySetting";
        value: proto.SyncActionValue.NotificationActivitySettingAction.NotificationActivitySetting;
      }
    | {
        setting: "channelsPersonalisedRecommendation";
        value: proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction;
      };
};

export type BufferedEventData = {
  historySets: {
    chats: { [jid: string]: Chat };
    contacts: { [jid: string]: Contact };
    messages: { [uqId: string]: WAMessage };
    empty: boolean;
    isLatest: boolean;
    progress?: number | null;
    syncType?: proto.HistorySync.HistorySyncType;
    peerDataRequestSessionId?: string;
  };
  chatUpserts: { [jid: string]: Chat };
  chatUpdates: { [jid: string]: ChatUpdate };
  chatDeletes: Set<string>;
  contactUpserts: { [jid: string]: Contact };
  contactUpdates: { [jid: string]: Partial<Contact> };
  messageUpserts: {
    [key: string]: { type: MessageUpsertType; message: WAMessage };
  };
  messageUpdates: { [key: string]: WAMessageUpdate };
  messageDeletes: { [key: string]: WAMessageKey };
  messageReactions: {
    [key: string]: { key: WAMessageKey; reactions: proto.IReaction[] };
  };
  messageReceipts: {
    [key: string]: { key: WAMessageKey; userReceipt: proto.IUserReceipt[] };
  };
  groupUpdates: { [jid: string]: Partial<GroupMetadata> };
};

export interface BaileysEventEmitter {
  on<T extends keyof BaileysEventMap>(
    event: T,
    listener: (arg: BaileysEventMap[T]) => void,
  ): void;
  off<T extends keyof BaileysEventMap>(
    event: T,
    listener: (arg: BaileysEventMap[T]) => void,
  ): void;
  removeAllListeners<T extends keyof BaileysEventMap>(event: T): void;
  emit<T extends keyof BaileysEventMap>(
    event: T,
    arg: BaileysEventMap[T],
  ): boolean;
  
  process(
    handler: (events: Partial<BaileysEventMap>) => void | Promise<void>,
  ): void;
}
