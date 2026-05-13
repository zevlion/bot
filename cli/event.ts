import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { config, isMediaMessage } from "./util";
import {
	isJidStatusBroadcast,
	type WAMessage,
	type WASocket
} from "../lib";

export const autoDownload = async (message: WAMessage, sock: WASocket) => {
	if (config?.media?.auto_download && isMediaMessage(message)) {
		try {
			const tmpDir = join(process.cwd(), "tmp");
			await mkdir(tmpDir, { recursive: true });

			const buffer = await sock.downloadMedia(message, "buffer");
			if (!buffer) return;

			const type = await fileTypeFromBuffer(buffer);
			const extension = type ? `.${type.ext}` : "";

			const fileName = `${message.key.id || Date.now()}${extension}`;
			const filePath = join(tmpDir, fileName);

			await writeFile(filePath, buffer);

			return filePath;
		} catch {
			return;
		}
	}
};

export const autoSaveStatus = async (msg: WAMessage, sock: WASocket) => {
	const remoteJid = msg.key.remoteJid;
	const selfId = sock.user?.id;

	if (
		config?.media?.auto_save_status &&
		remoteJid &&
		isJidStatusBroadcast(remoteJid) &&
		!msg.key.fromMe &&
		selfId
	) {
		const cleanMsg = JSON.parse(JSON.stringify(msg));

		await sock.sendMessage(selfId, { forward: cleanMsg }, { quoted: cleanMsg });
	}
};

