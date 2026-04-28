/**
 * Every bridge event type the adapter explicitly handles.
 */
export const KNOWN_BRIDGE_EVENT_TYPES = new Set<string>([
  
  "connected",
  "disconnected",
  "qr",
  "pairing_code",
  "pair_success",
  "pair_error",
  "logged_out",
  "connect_failure",
  "stream_error",
  "stream_replaced",
  "client_outdated",
  "temporary_ban",
  "qr_scanned_without_multidevice",
  
  "message",
  "receipt",
  "undecryptable_message",
  
  "push_name_update",
  "contact_update",
  "contact_updated",
  "picture_update",
  
  "presence",
  "chat_presence",
  
  "group_update",
  
  "archive_update",
  "pin_update",
  "mute_update",
  "star_update",
  "mark_chat_as_read_update",
  
  "incoming_call",
  // acknowledged but no Baileys equivalent
  "self_push_name_updated",
  "history_sync",
  "offline_sync_completed",
  "offline_sync_preview",
  "device_list_update",
  "disappearing_mode_changed",
  "business_status_update",
  "newsletter_live_update",
  "contact_number_changed",
  "contact_sync_requested",
  "user_about_update",
  /** app-state sync deletes — handled as noop until a Baileys consumer
   * needs them (they have no direct upstream equivalent and the bridge
   * already mutates its own caches when these arrive) */
  "delete_chat_update",
  "delete_message_for_me_update",
  
  "notification",
  "raw_node",
  
  "mex_notification",
]);
