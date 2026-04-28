import type { Contact } from "./Contact.ts";
import type { WAMessageAddressingMode } from "./Message.ts";

export type GroupParticipant = Contact & {
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  admin?: "admin" | "superadmin" | null;
};

export type ParticipantAction =
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "modify";

export type RequestJoinAction = "created" | "revoked" | "rejected";

export type RequestJoinMethod =
  | "invite_link"
  | "linked_group_join"
  | "non_admin_add"
  | undefined;

export interface GroupMetadata {
  id: string;
  notify?: string;
  
  addressingMode?: WAMessageAddressingMode;
  owner: string | undefined;
  ownerPn?: string | undefined;
  owner_country_code?: string | undefined;
  subject: string;
  
  subjectOwner?: string;
  subjectOwnerPn?: string;
  
  subjectTime?: number;
  creation?: number;
  desc?: string;
  descOwner?: string;
  descOwnerPn?: string;
  descId?: string;
  descTime?: number;
  
  linkedParent?: string;
  
  restrict?: boolean;
  
  announce?: boolean;
  
  memberAddMode?: boolean;
  
  joinApprovalMode?: boolean;
  
  isCommunity?: boolean;
  
  isCommunityAnnounce?: boolean;
  
  size?: number;
  // Baileys modified array
  participants: GroupParticipant[];
  ephemeralDuration?: number;
  inviteCode?: string;
  
  author?: string;
  authorPn?: string;
}

export interface WAGroupCreateResponse {
  status: number;
  gid?: string;
  participants?: [{ [key: string]: {} }];
}

export interface GroupModificationResponse {
  status: number;
  participants?: { [key: string]: {} };
}
