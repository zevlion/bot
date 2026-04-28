import type { URL } from "url";
import type { CacheConfig, DevicePropsInput } from "whatsapp-rust-bridge";
import type { proto } from "whatsapp-rust-bridge/proto-types";
import type { ILogger } from "../Utils/logger.ts";
import type { AuthenticationState } from "./Auth.ts";

export type WAVersion = [number, number, number];
export type WABrowserDescription = [string, string, string];

export type CacheStore = {
  get<T>(key: string): Promise<T> | T | undefined;
  set<T>(key: string, value: T): Promise<void> | void | number | boolean;
  del(key: string): void | Promise<void> | number | boolean;
  flushAll(): void | Promise<void>;
};

export type PatchedMessageWithRecipientJID = proto.IMessage & {
  recipientJid?: string;
};

export type SocketConfig = {
  
  waWebSocketUrl: string | URL;
  
  connectTimeoutMs: number;
  
  defaultQueryTimeoutMs: number | undefined;
  
  keepAliveIntervalMs: number;
  
  logger: ILogger;
  
  version: WAVersion;
  
  browser: WABrowserDescription;
  
  emitOwnEvents: boolean;
  
  auth: AuthenticationState;
  /**
   * Returns if a jid should be ignored,
   * no event for that jid will be triggered.
   * Messages from that jid will also not be decrypted
   * */
  shouldIgnoreJid: (jid: string) => boolean | undefined;
  
  options: RequestInit;
  /**
   * Cache configuration — tune TTL, capacity, or provide custom store backends.
   * Omitted fields keep defaults. See CacheConfig type for details.
   */
  cache?: CacheConfig;
  /**
   * Override the `DeviceProps` advertised in the pairing registration node
   * (display name in "Linked Devices" + server-side feature gating, e.g.
   * view-once payload vs `absent` stub for non-Android companions).
   *
   * Orthogonal to `browser` — that controls the connection identity, this
   * controls the post-pairing display identity. When omitted, defaults are
   * derived from `browser`. Setting `platformType: 'ANDROID_PHONE'` does
   * NOT switch the underlying transport — baileyrs still speaks the web
   * protocol; real Android companion mode (CRSC/TEE) is not implemented.
   */
  deviceProps?: DevicePropsInput;
};
