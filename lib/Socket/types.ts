import type { EventEmitter } from "events";
import type { WasmWhatsAppClient } from "whatsapp-rust-bridge";
import type { BaileysEventEmitter, SocketConfig } from "../Types/index.ts";
import type { ILogger } from "../Utils/logger.ts";


export interface SocketContext {
  ev: BaileysEventEmitter;
  logger: ILogger;
  fullConfig: SocketConfig;
  getUser: () => { id?: string; lid?: string } | undefined;
  setUser: (u: { id?: string; lid?: string }) => void;
  
  getClient: () => Promise<WasmWhatsAppClient>;
  
  getClientSync: () => WasmWhatsAppClient;
  
  ws: EventEmitter;
}


export const jidStr = (jid: { user: string; server: string }): string =>
  `${jid.user}@${jid.server}`;
