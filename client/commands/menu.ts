import os from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { registerCommand, getCommands } from "../plugin";
import type { Command } from "../plugin";
import type { SerializedMessage } from "../serialize";

const FANCY_MAP: Record<string, string> = {
  a: "ᴀ",
  b: "ʙ",
  c: "ᴄ",
  d: "ᴅ",
  e: "ᴇ",
  f: "ғ",
  g: "ɢ",
  h: "ʜ",
  i: "ɪ",
  j: "ᴊ",
  k: "ᴋ",
  l: "ʟ",
  m: "ᴍ",
  n: "ɴ",
  o: "ᴏ",
  p: "ᴘ",
  q: "ǫ",
  r: "ʀ",
  s: "s",
  t: "ᴛ",
  u: "ᴜ",
  v: "ᴠ",
  w: "ᴡ",
  x: "x",
  y: "ʏ",
  z: "ᴢ",
};

function fancy(text: string): string {
  return text
    .toLowerCase()
    .split("")
    .map((c) => FANCY_MAP[c] ?? c)
    .join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function runtime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`]
    .filter(Boolean)
    .join(" ");
}

function getVersion(): string {
  try {
    const pkg = readFileSync(
      join(import.meta.dir, "../../package.json"),
      "utf-8",
    );
    return JSON.parse(pkg).version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function cmdName(cmd: Command): string {
  if (typeof cmd.pattern === "string") return cmd.pattern;
  if (cmd.alias?.[0]) return cmd.alias[0];
  if (cmd.pattern instanceof RegExp) return cmd.pattern.source;
  return "unknown";
}

registerCommand({
  pattern: "menu",
  alias: ["help"],
  dontAddToCommandList: true,
  async func(msg: SerializedMessage) {
    const { client, remoteJid } = msg;
    const pushName = msg.raw.pushName?.replace(/[\r\n]+/gm, "") ?? "User";
    const commands = getCommands();

    const grouped = new Map<string, Command[]>();
    for (const cmd of commands) {
      if (cmd.dontAddToCommandList) continue;
      const cat = cmd.category ?? "misc";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(cmd);
    }

    const totalRam = os.totalmem();
    const usedRam = totalRam - os.freemem();

    let text =
      `╭━━━〔 ${fancy("menu")} 〕━━━\n` +
      `┃ \`\`\`${fancy("user")} : ${pushName}\`\`\`\n` +
      `┃ \`\`\`${fancy("plugins")} : ${commands.length}\`\`\`\n` +
      `┃ \`\`\`${fancy("runtime")} : ${runtime(process.uptime())}\`\`\`\n` +
      `┃ \`\`\`${fancy("mode")} : ${fancy("public")}\`\`\`\n` +
      `┃ \`\`\`${fancy("platform")} : ${os.platform()}\`\`\`\n` +
      `┃ \`\`\`${fancy("ram")} : ${formatBytes(usedRam)} / ${formatBytes(totalRam)}\`\`\`\n` +
      `┃ \`\`\`${fancy("version")} : v ${getVersion()}\`\`\`\n` +
      `╰━━━━━━━━━━━━━━━\n\n`;

    for (const [category, cmds] of grouped) {
      text += `╭─────────────\n`;
      text += `│ 「 ${fancy(category)} 」\n`;
      text += `╰┬────────────\n┌┤\n`;
      for (const cmd of cmds) {
        text += `││◦ ${fancy(cmdName(cmd))}\n`;
      }
      text += `│╰────────────\n╰─────────────\n\n`;
    }

    await client.sendMessage(remoteJid, { text: text.trimEnd() });
  },
});
