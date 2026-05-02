import { exec } from "node:child_process";
import { promisify } from "node:util";
import axios from "axios";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCommand } from "../plugin";
import { toMp4, toPTT } from "../util";
import type { SerializedMessage } from "../serialize";

const execPromise = promisify(exec);

const downloadState = new Map<
  string,
  { url: string; formats: any[]; title: string }
>();
const searchState = new Map<
  string,
  { results: { title: string; id: string; duration: string }[] }
>();
const mediaTypeState = new Map<string, { url: string; title: string }>();

let cookieExpiry: number | null = null;
let cookieFilePath: string | null = null;

const COOKIE_TTL_MS = 15 * 60 * 1000;

function getCookieArgs(): string {
  if (
    cookieFilePath &&
    cookieExpiry &&
    Date.now() < cookieExpiry &&
    existsSync(cookieFilePath)
  ) {
    return `--cookies "${cookieFilePath}"`;
  }
  if (cookieFilePath && existsSync(cookieFilePath)) {
    try {
      unlinkSync(cookieFilePath);
    } catch {}
  }
  cookieFilePath = null;
  cookieExpiry = null;
  return "";
}

function isCookieError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("sign in") ||
    lower.includes("login") ||
    lower.includes("cookie") ||
    lower.includes("age-restricted") ||
    lower.includes("private video") ||
    lower.includes("members only") ||
    lower.includes("confirm your age") ||
    lower.includes("this video is unavailable")
  );
}

async function loggedExec(command: string, options: any = {}) {
  try {
    return await execPromise(command, options);
  } catch (error: any) {
    const stderr = error.stderr?.toString() ?? "";
    if (isCookieError(stderr)) {
      const cookieError = new Error("COOKIE_REQUIRED") as any;
      cookieError.isCookieError = true;
      throw cookieError;
    }
    throw error;
  }
}

async function sendCookiePrompt(msg: SerializedMessage) {
  await msg.client.sendMessage(msg.remoteJid, {
    text: `YouTube requires authentication for this content.\n\nSet your cookies using:\n*ytc YOUR_COOKIE_STRING*`,
  });
}

async function downloadAndSendAudio(
  msg: SerializedMessage,
  url: string,
  title: string,
) {
  try {
    await msg.client.sendMessage(msg.remoteJid, {
      text: `Extracting audio for *${title}*...`,
    });

    const cookieArgs = getCookieArgs();
    const { stdout } = await loggedExec(
      `yt-dlp ${cookieArgs} "${url}" -f "ba" -o -`,
      {
        encoding: null,
        maxBuffer: 1024 * 1024 * 100,
      },
    );

    const { buffer, mimetype, seconds, ptt } = await toPTT(stdout);

    await msg.client.sendMessage(msg.remoteJid, {
      audio: buffer,
      mimetype,
      ptt,
      seconds: Math.floor(seconds ? seconds : 0),
    });
  } catch (e: any) {
    if (e.isCookieError) return sendCookiePrompt(msg);
    await msg.client.sendMessage(msg.remoteJid, {
      text: "Audio download failed.",
    });
  }
}

async function downloadAndSendVideo(
  msg: any,
  url: string,
  formatId: string,
  title: string,
) {
  try {
    await msg.client.sendMessage(msg.remoteJid, {
      text: `Processing *${title}*...`,
    });

    const cookieArgs = getCookieArgs();

    const { stdout: thumbUrl } = await loggedExec(
      `yt-dlp ${cookieArgs} --get-thumbnail "${url}"`,
    );

    const thumbResponse = await axios.get(thumbUrl.toString().trim(), {
      responseType: "arraybuffer",
    });
    const jpegThumbnail = Buffer.from(thumbResponse.data).toString("base64");

    const { stdout } = await loggedExec(
      `yt-dlp ${cookieArgs} "${url}" -f "${formatId}" -o -`,
      {
        encoding: null,
        maxBuffer: 1024 * 1024 * 100,
      },
    );

    const videoData = await toMp4(stdout);

    await msg.client.sendMessage(msg.remoteJid, {
      video: videoData.buffer,
      mimetype: "video/mp4",
      caption: title,
      jpegThumbnail,
    });
  } catch (e: any) {
    if (e.isCookieError) return sendCookiePrompt(msg);
    await msg.client.sendMessage(msg.remoteJid, { text: "Download failed." });
  }
}

registerCommand([
  {
    pattern: "ytc",
    category: "downloader",
    async func(msg) {
      const cookie = msg.args.slice(1).join(" ").trim();
      if (!cookie)
        return await msg.client.sendMessage(msg.remoteJid, {
          text: "Provide your YouTube cookie string.\nUsage: *ytc YOUR_COOKIE_STRING*",
        });

      if (cookieFilePath && existsSync(cookieFilePath)) {
        try {
          unlinkSync(cookieFilePath);
        } catch {}
      }

      const filePath = join(tmpdir(), `yt_cookies_${Date.now()}.txt`);
      writeFileSync(filePath, cookie, "utf-8");

      cookieFilePath = filePath;
      cookieExpiry = Date.now() + COOKIE_TTL_MS;

      setTimeout(() => {
        if (cookieFilePath && existsSync(cookieFilePath)) {
          try {
            unlinkSync(cookieFilePath);
          } catch {}
        }
        cookieFilePath = null;
        cookieExpiry = null;
      }, COOKIE_TTL_MS);

      await msg.client.sendMessage(msg.remoteJid, {
        text: ` Cookie set successfully. It will expire in *15 minutes*.`,
      });
    },
  },

  {
    pattern: "yts",
    category: "downloader",
    async func(msg) {
      const query = msg.args.slice(1).join(" ");
      if (!query)
        return await msg.client.sendMessage(msg.remoteJid, {
          text: "Provide a search term",
        });

      try {
        const cookieArgs = getCookieArgs();
        const { stdout } = await loggedExec(
          `yt-dlp ${cookieArgs} "ytsearch10:${query}" --get-title --get-id --get-duration`,
        );

        const lines = stdout.toString().trim().split("\n");
        const results: { title: string; id: string; duration: string }[] = [];
        let response = `*Search Results for:* ${query}\n\nReply with a number to choose:\n\n`;

        for (let i = 0; i < lines.length; i += 3) {
          const title = lines[i]!;
          const id = lines[i + 1]!;
          const duration = lines[i + 2]!;
          results.push({ title, id, duration });
          response += `*${i / 3 + 1}.* ${title} (${duration})\n`;
        }

        searchState.set(msg.remoteJid, { results });
        await msg.client.sendMessage(msg.remoteJid, { text: response });
      } catch (e: any) {
        if (e.isCookieError) return sendCookiePrompt(msg);
        await msg.client.sendMessage(msg.remoteJid, {
          text: "No results found.",
        });
      }
    },
  },

  {
    pattern: "yta",
    category: "downloader",
    async func(msg) {
      const url = msg.args[1];
      if (!url)
        return await msg.client.sendMessage(msg.remoteJid, {
          text: "Provide a YouTube URL",
        });

      try {
        const cookieArgs = getCookieArgs();
        const { stdout } = await loggedExec(`yt-dlp ${cookieArgs} "${url}" -J`);
        const metadata = JSON.parse(stdout.toString());
        await downloadAndSendAudio(msg, url, metadata.title);
      } catch (e: any) {
        if (e.isCookieError) return sendCookiePrompt(msg);
        await msg.client.sendMessage(msg.remoteJid, {
          text: "Error fetching audio.",
        });
      }
    },
  },

  {
    pattern: "ytv",
    category: "downloader",
    async func(msg) {
      const url = msg.args[1];
      if (!url)
        return await msg.client.sendMessage(msg.remoteJid, {
          text: "Provide a YouTube URL",
        });

      try {
        const cookieArgs = getCookieArgs();
        const { stdout } = await loggedExec(`yt-dlp ${cookieArgs} "${url}" -J`);
        const metadata = JSON.parse(stdout.toString());

        let formats = metadata.formats.filter(
          (f: any) =>
            f.height <= 480 && f.vcodec !== "none" && f.acodec !== "none",
        );

        if (formats.length === 0) {
          formats = [{ format_id: "best[height<=480]", height: 480 }];
        }

        if (formats.length === 1) {
          return await downloadAndSendVideo(
            msg,
            url,
            formats[0].format_id,
            metadata.title,
          );
        }

        downloadState.set(msg.remoteJid, {
          url,
          formats,
          title: metadata.title,
        });

        let menu = `*${metadata.title}*\n\nReply with a number:\n\n`;
        formats.forEach((f: any, i: number) => {
          const size = f.filesize || f.filesize_approx || 0;
          const sizeMB = size > 0 ? (size / 1024 / 1024).toFixed(1) : "Unknown";
          menu += `*${i + 1}* - ${f.height}p (~${sizeMB}MB)\n`;
        });

        await msg.client.sendMessage(msg.remoteJid, { text: menu });
      } catch (e: any) {
        if (e.isCookieError) return sendCookiePrompt(msg);
        await msg.client.sendMessage(msg.remoteJid, {
          text: "Error fetching video metadata.",
        });
      }
    },
  },

  {
    event: true,
    async func(msg) {
      const body = msg.body.trim();
      const choice = parseInt(body);
      if (isNaN(choice)) return;

      const jid = msg.remoteJid;

      if (mediaTypeState.has(jid)) {
        const { url, title } = mediaTypeState.get(jid)!;

        if (choice === 1) {
          mediaTypeState.delete(jid);
          try {
            const cookieArgs = getCookieArgs();
            const { stdout } = await loggedExec(
              `yt-dlp ${cookieArgs} "${url}" -J`,
            );
            const metadata = JSON.parse(stdout.toString());

            let formats = metadata.formats.filter(
              (f: any) =>
                f.height <= 480 && f.vcodec !== "none" && f.acodec !== "none",
            );
            if (formats.length === 0) {
              formats = [{ format_id: "best[height<=480]", height: 480 }];
            }

            if (formats.length === 1) {
              return await downloadAndSendVideo(
                msg,
                url,
                formats[0].format_id,
                title,
              );
            }

            downloadState.set(jid, { url, formats, title });

            let menu = `*${title}*\n\nReply with a number to pick quality:\n\n`;
            formats.forEach((f: any, i: number) => {
              const size = f.filesize || f.filesize_approx || 0;
              const sizeMB =
                size > 0 ? (size / 1024 / 1024).toFixed(1) : "Unknown";
              menu += `*${i + 1}* - ${f.height}p (~${sizeMB}MB)\n`;
            });

            await msg.client.sendMessage(jid, { text: menu });
          } catch (e: any) {
            if (e.isCookieError) return sendCookiePrompt(msg);
            await msg.client.sendMessage(jid, {
              text: "Error fetching video formats.",
            });
          }
          return;
        }

        if (choice === 2) {
          mediaTypeState.delete(jid);
          await downloadAndSendAudio(msg, url, title);
          return;
        }

        await msg.client.sendMessage(jid, {
          text: "Please reply *1* for Video or *2* for Audio.",
        });
        return;
      }

      if (searchState.has(jid)) {
        const { results } = searchState.get(jid)!;
        const index = choice - 1;

        if (index < 0 || index >= results.length) {
          await msg.client.sendMessage(jid, {
            text: `Please reply with a number between 1 and ${results.length}.`,
          });
          return;
        }

        const selected = results[index];
        searchState.delete(jid);

        const url = `https://www.youtube.com/watch?v=${selected?.id}`;
        mediaTypeState.set(jid, { url, title: selected?.title! });

        await msg.client.sendMessage(jid, {
          text: `*${selected?.title}*\n\nWhat would you like?\n\n*1* - Video\n*2* - Audio`,
        });
        return;
      }

      if (downloadState.has(jid)) {
        const state = downloadState.get(jid)!;
        const index = choice - 1;

        if (index >= 0 && index < state.formats.length) {
          const selected = state.formats[index];
          downloadState.delete(jid);
          await downloadAndSendVideo(
            msg,
            state.url,
            selected.format_id,
            state.title,
          );
        }
        return;
      }
    },
  },
]);
