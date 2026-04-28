import type { proto } from "whatsapp-rust-bridge/proto-types";
import type { AccountSettings } from "./Auth.ts";
import type { QuickReplyAction } from "./Bussiness.ts";
import type { BufferedEventData } from "./Events.ts";
import type { LabelActionBody } from "./Label.ts";
import type { ChatLabelAssociationActionBody } from "./LabelAssociation.ts";
import type { MessageLabelAssociationActionBody } from "./LabelAssociation.ts";
import type { MinimalMessage, WAMessageKey } from "./Message.ts";

export type WAPrivacyValue = "all" | "contacts" | "contact_blacklist" | "none";

export type WAPrivacyOnlineValue = "all" | "match_last_seen";

export type WAPrivacyGroupAddValue = "all" | "contacts" | "contact_blacklist";

export type WAReadReceiptsValue = "all" | "none";

export type WAPrivacyCallValue = "all" | "known";

export type WAPrivacyMessagesValue = "all" | "contacts";

export type WAPresence =
  | "unavailable"
  | "available"
  | "composing"
  | "recording"
  | "paused";

export const ALL_WA_PATCH_NAMES = [
  "critical_block",
  "critical_unblock_low",
  "regular_high",
  "regular_low",
  "regular",
] as const;

export type WAPatchName = (typeof ALL_WA_PATCH_NAMES)[number];

export interface PresenceData {
  lastKnownPresence: WAPresence;
  lastSeen?: number;
}

export type BotListInfo = {
  jid: string;
  personaId: string;
};

export type ChatMutation = {
  syncAction: proto.ISyncActionData;
  index: string[];
};

export type WAPatchCreate = {
  syncAction: proto.ISyncActionValue;
  index: string[];
  type: WAPatchName;
  apiVersion: number;
  operation: proto.SyncdMutation.SyncdOperation;
};

export type Chat = proto.IConversation & {
  lastMessageRecvTimestamp?: number;
};

export type ChatUpdate = Partial<
  Chat & {
    /**
     * if specified in the update,
     * the EV buffer will check if the condition gets fulfilled before applying the update
     * Right now, used to determine when to release an app state sync event
     *
     * @returns true, if the update should be applied;
     * false if it can be discarded;
     * undefined if the condition is not yet fulfilled
     * */
    conditional: (bufferedData: BufferedEventData) => boolean | undefined;

    timestamp?: number;
  }
>;

/**
 * the last messages in a chat, sorted reverse-chronologically. That is, the latest message should be first in the chat
 * for MD modifications, the last message in the array (i.e. the earlist message) must be the last message recv in the chat
 * */
export type LastMessageList =
  | MinimalMessage[]
  | proto.SyncActionValue.ISyncActionMessageRange;

export type ChatModification =
  | {
      archive: boolean;
      lastMessages: LastMessageList;
    }
  | { pushNameSetting: string }
  | { pin: boolean }
  | {
      mute: number | null;
    }
  | {
      clear: boolean;
      lastMessages: LastMessageList;
    }
  | {
      deleteForMe: {
        deleteMedia: boolean;
        key: WAMessageKey;
        timestamp: number;
      };
    }
  | {
      star: {
        messages: { id: string; fromMe?: boolean }[];
        star: boolean;
      };
    }
  | {
      markRead: boolean;
      lastMessages: LastMessageList;
    }
  | { delete: true; lastMessages: LastMessageList }
  | { contact: proto.SyncActionValue.IContactAction | null }
  | {
      disableLinkPreviews: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction;
    }
  | { addLabel: LabelActionBody }
  | { addChatLabel: ChatLabelAssociationActionBody }
  | { removeChatLabel: ChatLabelAssociationActionBody }
  | { addMessageLabel: MessageLabelAssociationActionBody }
  | { removeMessageLabel: MessageLabelAssociationActionBody }
  | { quickReply: QuickReplyAction };

export type InitialReceivedChatsState = {
  [jid: string]: {
    lastMsgRecvTimestamp?: number;

    lastMsgTimestamp: number;
  };
};

export type InitialAppStateSyncOptions = {
  accountSettings: AccountSettings;
};
