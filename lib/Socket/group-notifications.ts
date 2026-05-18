import type {
	CanonicalGroupAction,
	CanonicalGroupUpdate
} from "../Bridge/types.ts";
import type {
	BaileysEventMap,
	GroupMetadata,
	WAMessage
} from "../Types/index.ts";
import { WAProto } from "../Types/index.ts";

/**
 * Bridges `<notification type="w:gp2">` actions onto the two event surfaces
 * Inputs are already-normalized `CanonicalGroup*` values from the
 * `src/Bridge` adapter — see that module for the bridge → canonical mapping.
 */

const STUB = WAProto.WebMessageInfo.StubType;

const PARTICIPANT_STUBS = {
	add: STUB.GROUP_PARTICIPANT_ADD,
	remove: STUB.GROUP_PARTICIPANT_REMOVE,
	promote: STUB.GROUP_PARTICIPANT_PROMOTE,
	demote: STUB.GROUP_PARTICIPANT_DEMOTE,
	modify: STUB.GROUP_PARTICIPANT_CHANGE_NUMBER
} as const;

type ParticipantActionType = keyof typeof PARTICIPANT_STUBS;

const isParticipantAction = (
	a: CanonicalGroupAction
): a is CanonicalGroupAction & { type: ParticipantActionType } =>
	a.type in PARTICIPANT_STUBS;

/**
 * Domain event a group notification maps to (either participant or
 * settings). `null` when the action carries nothing useful for callers
 * (e.g. raw `create`/`link`/`unlink` payloads).
 */
export type GroupNotificationDomainEvent =
	| {
			name: "group-participants.update";
			payload: BaileysEventMap["group-participants.update"];
	  }
	| { name: "groups.update"; payload: BaileysEventMap["groups.update"] }
	| null;

/**
 * Whitelist of `RequestJoinMethod` values upstream Baileys recognizes.
 * The bridge's `MembershipRequestMethod` is a wire-string enum that may
 * grow with new variants; validating here keeps an unknown server-side
 * method from leaking into consumer code as a typed but invalid value.
 */
const KNOWN_REQUEST_METHODS = new Set<
	NonNullable<BaileysEventMap["group.join-request"]["method"]>
>(["invite_link", "linked_group_join", "non_admin_add"]);

const validateRequestMethod = (
	raw: string | undefined
): BaileysEventMap["group.join-request"]["method"] => {
	if (!raw) return undefined;
	return KNOWN_REQUEST_METHODS.has(
		raw as NonNullable<BaileysEventMap["group.join-request"]["method"]>
	)
		? (raw as BaileysEventMap["group.join-request"]["method"])
		: undefined;
};

export const buildGroupJoinRequestEvents = (
	notification: CanonicalGroupUpdate
): BaileysEventMap["group.join-request"][] => {
	const action = notification.action;
	const author = notification.author;
	const authorPn = notification.authorPn;

	if (action.type === "membershipApprovalRequest") {
		// Single user requesting join. The author IS the requester, so
		// without a real author there is no addressable participant —
		// dropping the event beats emitting one with `participant: ''`.
		if (!author) return [];
		return [
			{
				id: notification.groupJid,
				author,
				authorPn,
				participant: author,
				participantPn: authorPn,
				action: "created",
				method: validateRequestMethod(action.requestMethod)
			}
		];
	}

	if (action.type === "createdMembershipRequests") {
		// Batched fanout (typically community parent → linked group). Emit
		// one event per request entry; skip entries without a participant
		// JID rather than synthesizing blanks.
		if (!author) return [];
		const method = validateRequestMethod(action.requestMethod);
		return action.requests
			.filter(req => !!req.jid)
			.map(req => ({
				id: notification.groupJid,
				author,
				authorPn,
				participant: req.jid,
				participantPn: req.phoneNumber,
				action: "created",
				method
			}));
	}

	if (action.type === "revokedMembershipRequests") {
		// Admin revoked one or more pending requests. Method is unknown at
		// this point (server doesn't echo the original method back).
		if (!author) return [];
		return action.participants
			.filter(p => !!p.jid)
			.map(p => ({
				id: notification.groupJid,
				author,
				authorPn,
				participant: p.jid,
				participantPn: p.phoneNumber,
				action: "revoked",
				method: undefined
			}));
	}

	return [];
};

export const buildGroupNotificationDomainEvent = (
	notification: CanonicalGroupUpdate
): GroupNotificationDomainEvent => {
	const action = notification.action;
	if (isParticipantAction(action)) {
		const participants = action.participants.map(p => {
			const entry: { id: string; admin?: "admin" | "superadmin" | null } = {
				id: p.jid
			};
			if (action.type === "promote") entry.admin = "admin";
			else if (action.type === "demote") entry.admin = null;
			return entry;
		});
		return {
			name: "group-participants.update",
			payload: {
				id: notification.groupJid,
				author: notification.author ?? "",
				authorPn: notification.authorPn,
				participants,
				action: action.type
			}
		};
	}

	const update: Partial<GroupMetadata> = { id: notification.groupJid };
	if (notification.author !== undefined) update.author = notification.author;
	if (notification.authorPn !== undefined)
		update.authorPn = notification.authorPn;

	switch (action.type) {
		case "subject":
			update.subject = action.subject;
			if (action.subjectOwner) update.subjectOwner = action.subjectOwner;
			if (action.subjectTime != null) update.subjectTime = action.subjectTime;
			break;
		case "description":
			update.descId = action.id;
			if (action.description != null) update.desc = action.description;
			break;
		case "ephemeral":
			update.ephemeralDuration = action.expiration;
			break;
		case "locked":
			update.restrict = true;
			break;
		case "unlocked":
			update.restrict = false;
			break;
		case "announce":
			update.announce = true;
			break;
		case "notAnnounce":
			update.announce = false;
			break;
		case "membershipApprovalMode":
			update.joinApprovalMode = action.enabled;
			break;
		case "memberAddMode":
			update.memberAddMode = action.mode === "all_member_add";
			break;
		case "invite":
		case "revokeInvite":
		case "create":
		case "delete":
		case "link":
		case "unlink":
			update.id = action.type;
			break;
	}

	return { name: "groups.update", payload: [update] };
};

interface StubRecipe {
	stubType: number;
	stubParams: string[];

	idSuffix: string;
}

const stubRecipesFor = (action: CanonicalGroupAction): StubRecipe[] => {
	if (isParticipantAction(action)) {
		const stubType = PARTICIPANT_STUBS[action.type];
		return action.participants.map((p, idx) => ({
			stubType,
			stubParams: [p.jid],
			idSuffix: `${idx}-${p.jid.split("@")[0]}`
		}));
	}

	switch (action.type) {
		case "subject":
			return [
				{
					stubType: STUB.GROUP_CHANGE_SUBJECT,
					stubParams: [action.subject],
					idSuffix: "subject"
				}
			];
		case "description":
			return [
				{
					stubType: STUB.GROUP_CHANGE_DESCRIPTION,
					stubParams: action.description != null ? [action.description] : [],
					idSuffix: "desc"
				}
			];
		case "locked":
			return [
				{
					stubType: STUB.GROUP_CHANGE_RESTRICT,
					stubParams: ["on"],
					idSuffix: "restrict"
				}
			];
		case "unlocked":
			return [
				{
					stubType: STUB.GROUP_CHANGE_RESTRICT,
					stubParams: ["off"],
					idSuffix: "restrict"
				}
			];
		case "announce":
			return [
				{
					stubType: STUB.GROUP_CHANGE_ANNOUNCE,
					stubParams: ["on"],
					idSuffix: "announce"
				}
			];
		case "notAnnounce":
			return [
				{
					stubType: STUB.GROUP_CHANGE_ANNOUNCE,
					stubParams: ["off"],
					idSuffix: "announce"
				}
			];
		case "membershipApprovalMode":
			return [
				{
					stubType: STUB.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE,
					stubParams: [action.enabled ? "on" : "off"],
					idSuffix: "jam"
				}
			];
		case "memberAddMode":
			return [
				{
					stubType: STUB.GROUP_MEMBER_ADD_MODE,
					stubParams: [action.mode],
					idSuffix: "mam"
				}
			];
		case "revokeInvite":
			return [
				{
					stubType: STUB.GROUP_CHANGE_INVITE_LINK,
					stubParams: [],
					idSuffix: "rinv"
				}
			];
		case "create":
			return [
				{ stubType: STUB.GROUP_CREATE, stubParams: [], idSuffix: "create" }
			];
		case "noFrequentlyForwarded":
			return [
				{
					stubType: STUB.GROUP_CHANGE_NO_FREQUENTLY_FORWARDED,
					stubParams: [],
					idSuffix: "nff"
				}
			];
		default:
			return [];
	}
};

/**
 * Build all stub WAMessages a group notification action should fan out to.
 */
export const buildGroupNotificationStubMessages = (
	notification: CanonicalGroupUpdate,
	fromMe: boolean
): WAMessage[] =>
	stubRecipesFor(notification.action).map(
		r =>
			WAProto.WebMessageInfo.fromObject({
				key: {
					remoteJid: notification.groupJid,
					fromMe,
					id: `BAE-GP-${notification.timestamp}-${r.stubType}-${r.idSuffix}`,
					participant: notification.author
				},
				participant: notification.author,
				messageTimestamp: notification.timestamp,
				messageStubType: r.stubType,
				messageStubParameters: r.stubParams
			}) as WAMessage
	);
