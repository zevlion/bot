/**
 * Type guards and coercion helpers shared by all bridge adapters.
 *
 * Adapters treat the bridge payload as `unknown` and validate field-by-field
 * here so a bridge schema drift (renamed field, lost serde rename_all,
 * timestamp serializer change) surfaces as `null` from one adapter instead
 * of a silent type lie that propagates downstream.
 */

/**
 * Plain-object guard. `typeof null === "object"` so we exclude it
 * explicitly; arrays return `true` here so callers must check
 * `Array.isArray` first if they need to distinguish.
 */
export const isObject = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x)


export const asString = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)


export const asNumber = (x: unknown): number | undefined =>
	typeof x === 'number' && Number.isFinite(x) ? x : undefined


export const asBool = (x: unknown): boolean | undefined => (typeof x === 'boolean' ? x : undefined)


export const asBoolOr = (x: unknown, fallback: boolean): boolean => asBool(x) ?? fallback

/**
 * Bridge JID struct — `user@server`, plus optional `agent`/`device`/
 * `integrator` for multi-device addressing. We always drop the latter when
 * stringifying so canonical JIDs are device-stripped (matching how Baileys
 * consumers index and compare).
 */
export interface BridgeJid {
	user: string
	server: string
	agent?: number
	device?: number
	integrator?: number
}


export const isBridgeJid = (x: unknown): x is BridgeJid =>
	isObject(x) && typeof x.user === 'string' && typeof x.server === 'string'


export const asBridgeJid = (x: unknown): BridgeJid | undefined => (isBridgeJid(x) ? x : undefined)


export const bridgeJidToString = (j: BridgeJid): string => `${j.user}@${j.server}`


export const asJidString = (x: unknown): string | undefined => {
	const j = asBridgeJid(x)
	return j ? bridgeJidToString(j) : undefined
}

/**
 * Coerce a timestamp value into unix seconds. Accepts both numbers and ISO
 * strings — the bridge serializes `DateTime<Utc>` as ISO unless explicitly
 * typed with `ts_seconds`, so being lenient here insulates us from drift.
 */
export const toUnixSeconds = (raw: unknown): number => {
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw
	if (typeof raw === 'string') {
		const ms = Date.parse(raw)
		if (Number.isFinite(ms)) return Math.floor(ms / 1000)
	}
	return 0
}

/**
 * Lowercase a discriminator string defensively — handles both the current
 * lowercase wire-tag form and any legacy PascalCase form an older bridge
 * might still emit.
 */
export const normalizeDiscriminator = (x: unknown): string | undefined => {
	const s = asString(x)
	return s ? s.toLowerCase() : undefined
}
