import { Buffer } from "node:buffer";
import type { JsStoreCallbacks } from "whatsapp-rust-bridge";
import type { proto } from "whatsapp-rust-bridge/proto-types";
import type { Contact } from "./Contact.ts";

export type KeyPair = { public: Uint8Array; private: Uint8Array };
export type SignedKeyPair = {
  keyPair: KeyPair;
  signature: Uint8Array;
  keyId: number;
  timestampS?: number;
};

export type ProtocolAddress = {
  name: string;
  deviceId: number;
};
export type SignalIdentity = {
  identifier: ProtocolAddress;
  identifierKey: Uint8Array;
};

export type LIDMapping = {
  pn: string;
  lid: string;
};

export type LTHashState = {
  version: number;
  hash: Buffer;
  indexValueMap: {
    [indexMacBase64: string]: { valueMac: Uint8Array | Buffer };
  };
};

export type AccountSettings = {
  unarchiveChats: boolean;

  defaultDisappearingMode?: Pick<
    proto.IConversation,
    "ephemeralExpiration" | "ephemeralSettingTimestamp"
  >;
};

/**
 * Authentication credentials.
 *
 * Only `me`, `registered`, and `platform` are actively used by the socket.
 * All crypto keys and Signal state are managed internally by the Rust bridge.
 * The remaining fields exist for backward compatibility with user code that
 * may reference them.
 */
export type AuthenticationCreds = {
  me?: Contact;
  registered: boolean;
  platform?: string;
  noiseKey?: KeyPair;
  pairingEphemeralKeyPair?: KeyPair;
  signedIdentityKey?: KeyPair;
  signedPreKey?: SignedKeyPair;
  registrationId?: number;
  advSecretKey?: string;
  account?: proto.IAdvSignedDeviceIdentity;
  signalIdentities?: SignalIdentity[];
  myAppStateKeyId?: string;
  firstUnuploadedPreKeyId?: number;
  nextPreKeyId?: number;
  lastAccountSyncTimestamp?: number;
  processedHistoryMessages?: Array<{
    key: { remoteJid?: string; id?: string };
    messageTimestamp?: number;
  }>;
  accountSyncCounter?: number;
  accountSettings?: AccountSettings;
  pairingCode?: string;
  lastPropHash?: string;
  routingInfo?: Buffer;
  additionalData?: Record<string, unknown>;
};

export type AuthenticationState = {
  store?: JsStoreCallbacks & {
    flush?(): Promise<void>;
  };
};
