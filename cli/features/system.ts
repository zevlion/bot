import os from "os";
import { join } from "path";
import { readdir, stat, rm, mkdir } from "fs/promises";
import { registerCommand } from "../cmd";
import { runtime, formatBytes } from "./menu";

registerCommand([
	{
		pattern: "ping",
		alias: ["p"],
		async func(msg) {
			const { client, remoteJid, id } = msg;
			const start = Date.now();
			const sent = await client.sendMessage(remoteJid, { text: `Ping ${id}` });
			const elapsed = Date.now() - start;
			await client.sendMessage(remoteJid, {
				edit: sent!.key,
				text: `\`\`\`Pong ${elapsed} ms\`\`\``
			});
		}
	},
	{
		pattern: "uptime",
		alias: ["runtime"],
		async func(msg) {
			const uptime = runtime(process.uptime());
			return msg.client.sendMessage(msg.remoteJid, {
				text: `\`\`\`Running since: ${uptime}\`\`\``
			});
		}
	},
	{
		pattern: "ram",
		alias: ["memory"],
		async func(msg) {
			const total = os.totalmem();
			const used = total - os.freemem();
			const pct = ((used / total) * 100).toFixed(1);
			return msg.client.sendMessage(msg.remoteJid, {
				text: `\`\`\`RAM: ${formatBytes(used)} / ${formatBytes(total)} (${pct}%)\`\`\``
			});
		}
	},
	{
		pattern: "sysinfo",
		async func(msg) {
			const total = os.totalmem();
			const used = total - os.freemem();
			const cpus = os.cpus();
			const load = os.loadavg();

			const text =
				`\`\`\`System Info\n` +
				`Platform : ${os.platform()} ${os.arch()}\n` +
				`Hostname : ${os.hostname()}\n` +
				`CPU      : ${cpus[0]?.model ?? "Unknown"} (${cpus.length} cores)\n` +
				`Load avg : ${load.map(l => l.toFixed(2)).join(" | ")}\n` +
				`RAM      : ${formatBytes(used)} / ${formatBytes(total)}\n` +
				`Uptime   : ${runtime(process.uptime())}\`\`\``;

			return msg.client.sendMessage(msg.remoteJid, { text });
		}
	},

	{
		pattern: "tmp",
		fromMe: true,
		category: "owner",
		async func(msg) {
			const tmpDir = join(process.cwd(), "tmp");

			const formatSize = (bytes: number): string => {
				if (bytes === 0) return "0 B";
				const k = 1024;
				const sizes = ["B", "KB", "MB", "GB"];
				const i = Math.floor(Math.log(bytes) / Math.log(k));
				return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
			};

			const getDirSize = async (dir: string): Promise<number> => {
				const files = await readdir(dir, { withFileTypes: true });
				const paths = files.map(async file => {
					const path = join(dir, file.name);
					if (file.isDirectory()) return await getDirSize(path);
					const { size } = await stat(path);
					return size;
				});
				return (await Promise.all(paths)).reduce((acc, size) => acc + size, 0);
			};

			try {
				let totalSize = 0;
				try {
					totalSize = await getDirSize(tmpDir);
				} catch {
					return await msg.client.sendMessage(msg.remoteJid, {
						text: "_Tmp directory is already empty or does not exist._"
					});
				}

				await rm(tmpDir, { recursive: true, force: true });
				await mkdir(tmpDir, { recursive: true });

				await msg.client.sendMessage(msg.remoteJid, {
					text: `\`\`\`Cleaned: ${formatSize(totalSize)}\`\`\``
				});
			} catch {
				await msg.client.sendMessage(msg.remoteJid, {
					text: "_Error while cleaning tmp directory._"
				});
			}
		}
	}
]);
