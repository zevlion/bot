import {
	Boom,
	makeWASocket,
	useBridgeStore,
	DisconnectReason,
} from "../lib";
import process from "process";
import readline from "readline";
import * as qrcode from "qrcode-terminal";
import serialize from "./serialize";
import { getCommands, loadCommands, matchCommand } from "./cmd";
import { autoDownload, autoSaveStatus } from "./event";

interface CliArgs {
	help: boolean;
	retries: number;
	pair: string | null;
	qrcode: boolean;
}

function printHelp(): void {
	console.log(`
Usage: bun start [options]

Options:
  -h, --help            Show this help message and exit
  -r, --run [retries]   Max reconnect retries (default: 0)
  -p, --pair <number>   Phone number to use for pairing code auth
  -qr, --qrcode         Force QR code display

Examples:
  bun start
  bun start -r 5
  bun start --run 3 -p +2348012345
  bun start -qr
`);
}

function parseArgs(argv: string[]): CliArgs {
	const args = argv.slice(2);
	const result: CliArgs = {
		help: false,
		retries: 0,
		pair: null,
		qrcode: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "-h" || arg === "--help") {
			result.help = true;
		} else if (arg === "-r" || arg === "--run") {
			const next = args[i + 1];
			if (next !== undefined && /^\d+$/.test(next)) {
				result.retries = parseInt(next, 10);
				i++;
			}
		} else if (arg === "-p" || arg === "--pair") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				console.error(`Error: ${arg} requires a phone number argument.`);
				process.exit(1);
			}
			result.pair = next;
			i++;
		} else if (arg === "-qr" || arg === "--qrcode") {
			result.qrcode = true;
		} else {
			console.error(`Unknown argument: ${arg}`);
			printHelp();
			process.exit(1);
		}
	}

	return result;
}

const cli = parseArgs(process.argv);

if (cli.help) {
	printHelp();
	process.exit(0);
}

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

const question = (text: string) =>
	new Promise<string>((resolve) => rl.question(text, resolve));

const startSock = async () => {
	const auth = { store: await useBridgeStore() };
	await loadCommands();

	const strategy = cli.qrcode ? "qr" : cli.pair ? "pairing_code" : "qr";

	let pairingRequested = false;
	let retryCount = 0;

	const sock = makeWASocket({
		auth,
		emitOwnEvents: false,
	});

	sock.ev.process(async (events) => {
		if (events["connection.update"]) {
			const update = events["connection.update"];
			const { connection, lastDisconnect, qr } = update;

			if (qr && strategy !== "pairing_code") {
				qrcode.generate(qr, { small: true });
			}

			if (
				qr &&
				strategy === "pairing_code" &&
				!sock.isLoggedIn &&
				!pairingRequested
			) {
				pairingRequested = true;
				let phoneNumber = cli.pair;
				if (!phoneNumber) {
					phoneNumber = await question("Please enter your phone number:\n");
				} else {
					console.log(`Using phone number: ${phoneNumber}`);
				}
				try {
					const code = await sock.requestPairingCode(
						phoneNumber.replace(/[^\d]/g, ""),
					);
					console.log(`Pairing code: ${code}`);
				} catch {
					pairingRequested = false;
				}
			}

			if (connection === "close") {
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
				const shouldReconnect = retryCount < cli.retries;

				if (statusCode === DisconnectReason.loggedOut) {
					console.log("Logged out.");
					rl.close();
				} else if (shouldReconnect) {
					retryCount++;
					console.log(`Reconnecting... (${retryCount}/${cli.retries})`);
					startSock();
				} else {
					console.log("Connection closed.");
					rl.close();
				}
			}

			if (connection === "open") {
				console.log("Connected.");
				retryCount = 0;
			}
		}

		if (events["messages.upsert"]) {
			const upsert = events["messages.upsert"];
			if (upsert.type === "notify") {
				for (const raw of upsert.messages) {
					const msg = serialize(raw, sock);
					if (!msg || !msg.body || !msg.fromMe) continue;

					const eventCommands = getCommands().filter((cmd) => cmd.event === true);
					for (const eventCmd of eventCommands) {
						await eventCmd.func(msg);
					}

					const cmd = matchCommand(msg);
					if (cmd && !cmd.event) {
						await cmd.func(msg);
					}

					await Promise.all([autoDownload(raw, sock), autoSaveStatus(raw, sock)]);
				}
			}
		}
	});

	return sock;
};

startSock();