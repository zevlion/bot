import sharp from "sharp";
import { Buffer } from "buffer";
import { execFile } from "child_process";
import { createReadStream, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { Boom } from "./boom.ts";
import type { HeadersInit } from "bun";
import type { ILogger } from "./logger.ts";
import type { WAMediaUpload } from "../Types/index.ts";
import type { IAudioMetadata } from "music-metadata";
import type { ReadableStream as WebReadableStream } from "stream/web";

const randomId = () => globalThis.crypto.randomUUID();

const getTmpFilesDirectory = () => tmpdir();

const extractVideoThumb = async (
	path: string,
	destPath: string,
	time: string,
	size: { width: number; height: number }
) =>
	new Promise<void>((resolve, reject) => {
		execFile(
			"ffmpeg",
			[
				"-ss",
				time,
				"-i",
				path,
				"-y",
				"-vf",
				`scale=${size.width}:-1`,
				"-vframes",
				"1",
				"-f",
				"image2",
				destPath
			],
			err => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			}
		);
	});

export const extractImageThumb = async (
	bufferOrFilePath: Readable | Buffer | string,
	width = 32
) => {
	if (bufferOrFilePath instanceof Readable) {
		bufferOrFilePath = await toBuffer(bufferOrFilePath);
	}

	const img = sharp(bufferOrFilePath);
	const dimensions = await img.metadata();

	const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer();
	return {
		buffer,
		original: {
			width: dimensions.width,
			height: dimensions.height
		}
	};
};

export async function getAudioDuration(buffer: Buffer | string | Readable) {
	const musicMetadata = await import("music-metadata");
	let metadata: IAudioMetadata;
	const options = {
		duration: true
	};
	if (Buffer.isBuffer(buffer)) {
		metadata = await musicMetadata.parseBuffer(buffer, undefined, options);
	} else if (typeof buffer === "string") {
		metadata = await musicMetadata.parseFile(buffer, options);
	} else {
		metadata = await musicMetadata.parseStream(buffer, undefined, options);
	}

	return metadata.format.duration;
}

export async function getAudioWaveform(
	buffer: Buffer | string | Readable,
	logger?: ILogger
) {
	try {
		const { default: decoder } = await import("audio-decode");
		let audioData: Buffer;
		if (Buffer.isBuffer(buffer)) {
			audioData = buffer;
		} else if (typeof buffer === "string") {
			const rStream = createReadStream(buffer);
			audioData = await toBuffer(rStream);
		} else {
			audioData = await toBuffer(buffer);
		}

		const audioBuffer = await decoder(audioData);

		const rawData = audioBuffer.channelData[0];
		if (!rawData) {
			logger?.debug("No audio data found in first channel");
			return new Uint8Array(64);
		}

		const samples = 64;
		const blockSize = Math.floor(rawData.length / samples);
		const filteredData: number[] = [];

		for (let i = 0; i < samples; i++) {
			const blockStart = blockSize * i;
			let sum = 0;
			for (let j = 0; j < blockSize; j++) {
				sum = sum + Math.abs(rawData[blockStart + j]!);
			}
			filteredData.push(sum / blockSize);
		}

		const multiplier = Math.pow(Math.max(...filteredData), -1);
		const normalizedData = filteredData.map(n => n * multiplier);

		const waveform = new Uint8Array(
			normalizedData.map(n => Math.floor(100 * n))
		);

		return waveform;
	} catch (e) {
		logger?.debug("Failed to generate waveform: " + e);
		return new Uint8Array(64);
	}
}

export const toReadable = (buffer: Buffer) => {
	const readable = new Readable({ read: () => {} });
	readable.push(buffer);
	readable.push(null);
	return readable;
};

export const toBuffer = async (stream: Readable) => {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}

	stream.destroy();
	return Buffer.concat(chunks);
};

export const getStream = async (
	item: WAMediaUpload,
	opts?: RequestInit & { maxContentLength?: number }
) => {
	if (Buffer.isBuffer(item)) {
		return { stream: toReadable(item), type: "buffer" } as const;
	}

	if ("stream" in item) {
		return { stream: item.stream, type: "readable" } as const;
	}

	const urlStr = item.url.toString();

	if (urlStr.startsWith("data:")) {
		const buffer = Buffer.from(urlStr.split(",")[1]!, "base64");
		return { stream: toReadable(buffer), type: "buffer" } as const;
	}

	if (urlStr.startsWith("http://") || urlStr.startsWith("https://")) {
		return {
			stream: await getHttpStream(item.url, opts),
			type: "remote"
		} as const;
	}

	return { stream: createReadStream(item.url), type: "file" } as const;
};

export async function generateThumbnail(
	bufferOrPath: Buffer | string,
	mediaType: "video" | "image",
	options: {
		logger?: ILogger;
	}
) {
	let thumbnail: string | undefined;
	let originalImageDimensions: { width: number; height: number } | undefined;
	if (mediaType === "image") {
		const { buffer, original } = await extractImageThumb(bufferOrPath);
		thumbnail = buffer.toString("base64");
		if (original.width && original.height) {
			originalImageDimensions = {
				width: original.width,
				height: original.height
			};
		}
	} else if (mediaType === "video") {
		let filePath: string;
		let needsCleanup = false;
		if (Buffer.isBuffer(bufferOrPath)) {
			filePath = join(getTmpFilesDirectory(), "vid-" + randomId());
			await fs.writeFile(filePath, bufferOrPath);
			needsCleanup = true;
		} else {
			filePath = bufferOrPath;
		}

		const imgFilename = join(getTmpFilesDirectory(), randomId() + ".jpg");
		try {
			await extractVideoThumb(filePath, imgFilename, "00:00:00", {
				width: 32,
				height: 32
			});
			const buff = await fs.readFile(imgFilename);
			thumbnail = buff.toString("base64");

			await fs.unlink(imgFilename);
		} catch (err) {
			options.logger?.debug("could not generate video thumb: " + err);
		}

		if (needsCleanup) {
			try {
				await fs.unlink(filePath);
			} catch {}
		}
	}

	return {
		thumbnail,
		originalImageDimensions
	};
}

export const getHttpStream = async (
	url: string | URL,
	options: RequestInit & { isStream?: true } = {}
) => {
	const response = await fetch(url.toString(), {
		dispatcher: options.dispatcher,
		method: "GET",
		headers: options.headers as HeadersInit
	});
	if (!response.ok) {
		throw new Boom(`Failed to fetch stream from ${url}`, {
			statusCode: response.status,
			data: { url }
		});
	}

	return response.body instanceof Readable
		? response.body
		: Readable.fromWeb(response.body as WebReadableStream);
};

export type MediaDownloadOptions = {
	options?: RequestInit;
};
