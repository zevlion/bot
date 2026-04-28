import { registerCommand } from "../plugin";
import type { SerializedMessage } from "../serialize";

registerCommand({
  pattern: "ping",
  alias: ["p"],
  async func(msg: SerializedMessage) {
    const { client, remoteJid, id } = msg;
    const start = Date.now();
    const sent = await client.sendMessage(remoteJid, { text: `Ping ${id}` });
    const elapsed = Date.now() - start;
    await client.sendMessage(remoteJid, {
      edit: sent!.key,
      text: `\`\`\`Pong ${elapsed} ms\`\`\``,
    });
  },
});
