import type { Boom } from "../Utils/boom.ts";
import type { Contact } from "./Contact.ts";
import type { ReachoutTimelockState } from "./Reachout.ts";

export type WAConnectionState = "open" | "connecting" | "close";

export type ConnectionState = {
  
  connection: WAConnectionState;

  
  lastDisconnect?: {
    error: Boom | Error | undefined;
    date: Date;
  };
  
  isNewLogin?: boolean;
  
  qr?: string;
  
  receivedPendingNotifications?: boolean;
  
  legacy?: {
    phoneConnected: boolean;
    user?: Contact;
  };
  /**
   * if the client is shown as an active, online client.
   * If this is false, the primary phone and other devices will receive notifs
   * */
  isOnline?: boolean;
  /**
   * Server-imposed cooldown on outbound messaging to NEW contacts.
   * Emitted both via push (`NotificationUserReachoutTimelockUpdate`) and
   * after `fetchReachoutTimelock()`. See `ReachoutTimelockState`.
   */
  reachoutTimeLock?: ReachoutTimelockState;
};
