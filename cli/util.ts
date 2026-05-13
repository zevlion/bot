import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import { exec } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { parse } from "smol-toml";
import { getAudioDuration, type WAMessage } from "../lib";

interface BotConfig {
	metadata: {
		author: string;
		primary_platform: string;
		supported_platform: string;
	};
	media: {
		auto_download: boolean;
		auto_save_status: boolean;
	};
	features: {
		bot_name: string;
	};
}

const execPromise = promisify(exec);

const rawConfig = readFileSync("./config.toml", "utf-8");
export const config = parse(rawConfig) as unknown as BotConfig;

async function processMedia(
	input: string | Buffer,
	outputExt: string,
	mimetype: string,
	ffmpegArgs: string,
): Promise<{
	buffer: Buffer;
	mimetype: string;
	seconds?: number;
}> {
	const tempInput = join(tmpdir(), `input_${Date.now()}`);
	const tempOutput = join(tmpdir(), `output_${Date.now()}.${outputExt}`);

	try {
		if (Buffer.isBuffer(input)) {
			writeFileSync(tempInput, input);
		} else {
			// If input is a path string, we can just use it, but tempInput simplifies the try/finally
			writeFileSync(tempInput, readFileSync(input));
		}

		await execPromise(
			`ffmpeg -i "${tempInput}" ${ffmpegArgs} -y "${tempOutput}"`,
		);

		const buffer = readFileSync(tempOutput);
		const seconds = await getAudioDuration(tempOutput);

		return {
			buffer,
			mimetype,
			seconds,
		};
	} finally {
		try {
			unlinkSync(tempInput);
		} catch {}
		try {
			unlinkSync(tempOutput);
		} catch {}
	}
}

export async function toMp3(input: string | Buffer): Promise<{
	buffer: Buffer;
	mimetype: string;
	seconds?: number;
}> {
	return processMedia(input, "mp3", "audio/mpeg", "-vn -ab 192k -ar 44100");
}

export async function toPTT(input: string | Buffer): Promise<
	{
		buffer: Buffer;
		mimetype: string;
		seconds?: number;
	} & { ptt: true }
> {
	const result = await processMedia(
		input,
		"ogg",
		"audio/ogg; codecs=opus",
		"-vn -c:a libopus -b:a 128k -vbr on",
	);

	return {
		ptt: true,
		...result,
	};
}

export async function toMp4(input: string | Buffer): Promise<{
	buffer: Buffer;
	mimetype: string;
	seconds?: number;
}> {
	const tempInput = join(tmpdir(), `input_${Date.now()}`);
	const tempOutput = join(tmpdir(), `output_${Date.now()}.mp4`);

	try {
		if (Buffer.isBuffer(input)) {
			writeFileSync(tempInput, input);
		} else {
			writeFileSync(tempInput, readFileSync(input));
		}

		await execPromise(
			`ffmpeg -i "${tempInput}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p -y "${tempOutput}"`,
		);

		const buffer = readFileSync(tempOutput);

		return {
			buffer,
			mimetype: "video/mp4",
		};
	} finally {
		try {
			unlinkSync(tempInput);
		} catch {}
		try {
			unlinkSync(tempOutput);
		} catch {}
	}
}

export const extractText = (msg: WAMessage) => {
	return (
		msg.message?.conversation ||
		msg.message?.extendedTextMessage?.text ||
		msg.message?.imageMessage?.caption ||
		msg.message?.videoMessage?.caption ||
		msg.message?.documentMessage?.caption ||
		""
	);
};

export const isMediaMessage = (msg: WAMessage) => {
	const message = msg.message;
	if (!message) return false;

	// List of common media keys in the WhatsApp protobuf
	const mediaKeys = [
		"imageMessage",
		"videoMessage",
		"audioMessage",
		"documentMessage",
		"stickerMessage",
	];

	return mediaKeys.some((key) => Object.hasOwn(message, key));
};
