import type { WAMessage, WASocket } from "../lib";

export type Client = WASocket;

export interface SerializedMessage {
  
  raw: WAMessage;

  
  client: Client;

  
  remoteJid: string;

  
  id: string;

  
  fromMe: boolean;

  
  isGroup: boolean;

  
  sender: string;

  
  body: string;

  
  timestamp: number;

  
  args: string[];

  
  command: string;
}

export default function (
  msg: WAMessage,
  client: Client,
): SerializedMessage | null {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return null;

  const isGroup = remoteJid.endsWith("@g.us");
  const fromMe = msg.key.fromMe ?? false;

  // In groups the participant field holds the actual sender
  const sender = isGroup
    ? (msg.key.participant ?? msg.participant ?? remoteJid)
    : fromMe
      ? (client.user?.id ?? remoteJid)
      : remoteJid;

  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    "";

  const args = body.trim().split(/\s+/).filter(Boolean);
  const command = (args[0] ?? "").toLowerCase();

  return {
    raw: msg,
    client,
    remoteJid,
    id: msg.key.id ?? "",
    fromMe,
    isGroup,
    sender,
    body,
    timestamp:
      typeof msg.messageTimestamp === "number"
        ? msg.messageTimestamp
        : Number(msg.messageTimestamp ?? 0),
    args,
    command,
  };
}
