import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import { config, isMediaMessage } from "./util";
import type { WAMessage, WASocket } from "../lib";

export const autoDownload = async (message: WAMessage, sock: WASocket) => {
	if (config?.media?.auto_download && isMediaMessage(message)) {
		try {
			const tmpDir = join(process.cwd(), "tmp");
			await mkdir(tmpDir, { recursive: true });

			const buffer = await sock.downloadMedia(message, "buffer");

			const fileName = `${message.key.id || Date.now()}`;
			const filePath = join(tmpDir, fileName);

			await writeFile(filePath, buffer);

			return filePath;
		} catch {}
	}
};
