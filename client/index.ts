import { Boom, makeWASocket, useBridgeStore, DisconnectReason } from "../lib";
import process from "node:process";
import readline from "node:readline";
import * as qrcode from "qrcode-terminal";

import calls from "./calls";
import serialize from "./serialize";
import { config, logger } from "./util";
import { getCommands, loadCommands, matchCommand } from "./plugin";
import { autoDownload } from "./features";

logger.level = config.features?.enable_logs ? "trace" : "silent";

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

const question = (text: string) =>
	new Promise<string>((resolve) => rl.question(text, resolve));

const startSock = async () => {
	const state = await useBridgeStore();
	const cmd = await loadCommands();

	let pairingRequested = false;
	let retryCount = 0;

	const sock = makeWASocket({
		logger,
		auth: { store: state },
		emitOwnEvents: false
	});

	sock.ev.process(async (events) => {
		if (events["connection.update"]) {
			const update = events["connection.update"];
			const { connection, lastDisconnect, qr } = update;

			if (qr && config.auth.strategy !== "pairing_code") {
				qrcode.generate(qr, { small: true });
			}

			if (
				qr &&
				config.auth.strategy === "pairing_code" &&
				!sock.isLoggedIn &&
				!pairingRequested
			) {
				pairingRequested = true;
				const phoneNumber = await question("Please enter your phone number:\n");
				try {
					const code = await sock.requestPairingCode(
						phoneNumber.replace(/[^\d]/g, "")
					);
					console.log(`Pairing code: ${code}`);
				} catch (err) {
					logger.error(err, "Pairing code request failed");
					pairingRequested = false;
				}
			}

			if (connection === "close") {
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
				const shouldReconnect =
					config.connection.reconnect_on_failure &&
					retryCount < config.connection.max_retries;

				if (statusCode === DisconnectReason.loggedOut) {
					logger.fatal("Connection closed. You are logged out.");
				} else if (shouldReconnect) {
					retryCount++;
					startSock();
				}
			}

			if (connection === "open") {
				retryCount = 0;
				console.log(
					`[Plugin] Loaded ${cmd.commands.length} command(s) from ${cmd.files.length} file(s)`
				);
				console.log(`${config.features.bot_name} is connected to WhatsApp`);
			}

			logger.debug(update, "connection update");
		}

		if (events["call"]) {
			await calls(events.call);
		}

		if (events["messages.upsert"]) {
			const upsert = events["messages.upsert"];

			if (upsert.type === "notify") {
				for (const raw of upsert.messages) {
					const msg = serialize(raw, sock);
					await autoDownload(raw, sock);
					if (!msg || !msg.body) continue;

					const eventCommands = getCommands().filter(
						(cmd) => cmd.event === true
					);
					for (const eventCmd of eventCommands) {
						await eventCmd.func(msg);
					}

					const cmd = matchCommand(msg);
					if (cmd && !cmd.event) {
						await cmd.func(msg);
					}
				}
			}
		}
	});

	return sock;
};

startSock();
