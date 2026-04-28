/**
 * Reachout-timelock mapping: server payload → public `ReachoutTimelockState`.
 * Shared between the push-notification path (`Event::MexNotification` with
 * op_name `NotificationUserReachoutTimelockUpdate`) and the on-demand
 * `fetchReachoutTimelock()` IQ. Both deliver the same field shape.
 */
import {
  type ReachoutTimelockEnforcementType,
  type ReachoutTimelockState,
} from "../Types/Reachout.ts";


export interface ReachoutTimelockWire {
  is_active?: boolean;
  
  time_enforcement_ends?: string;
  enforcement_type?: string;
}

/** Locate the timelock object inside an arbitrary payload — the bridge
 *  hands us either the raw `xwa2_…` body (from `fetchReachoutTimelock`)
 *  or a wrapping MEX response (from the push notification). */
export function extractReachoutPayload(
  value: unknown,
): ReachoutTimelockWire | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const nested = v["xwa2_fetch_account_reachout_timelock"];
  if (nested && typeof nested === "object")
    return nested as ReachoutTimelockWire;
  const data = v["data"];
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>)[
      "xwa2_fetch_account_reachout_timelock"
    ];
    if (inner && typeof inner === "object")
      return inner as ReachoutTimelockWire;
  }
  // Caller already extracted — treat the value itself as the payload.
  if (
    "is_active" in v ||
    "time_enforcement_ends" in v ||
    "enforcement_type" in v
  ) {
    return v as ReachoutTimelockWire;
  }
  return null;
}

/** Map wire payload → public state. Returns `null` when the payload is
 *  empty or unparseable so callers can skip the emit. */
export function mapReachoutTimelock(
  value: unknown,
): ReachoutTimelockState | null {
  const wire = extractReachoutPayload(value);
  if (!wire) return null;
  const state: ReachoutTimelockState = {
    isActive: !!wire.is_active,
  };
  if (wire.time_enforcement_ends && wire.time_enforcement_ends !== "0") {
    const seconds = parseInt(wire.time_enforcement_ends, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      state.timeEnforcementEnds = new Date(seconds * 1000);
    }
  }
  if (wire.enforcement_type) {
    state.enforcementType =
      wire.enforcement_type as ReachoutTimelockEnforcementType;
  }
  return state;
}
