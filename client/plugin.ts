import type { SerializedMessage } from "./serialize";
import { join } from "node:path";

export interface Command {
  pattern?: string | RegExp;
  alias?: string[];
  fromMe?: boolean;
  isGroup?: boolean;
  func: (msg: SerializedMessage) => Promise<any | void>;
}

const commands: Command[] = [];

export function registerCommand(cmd: Command): void {
  commands.push(cmd);
}

export function matchCommand(msg: SerializedMessage): Command | undefined {
  return commands.find((cmd) => {
    if (cmd.fromMe !== undefined && msg.fromMe !== cmd.fromMe) return false;
    if (cmd.isGroup !== undefined && msg.isGroup !== cmd.isGroup) return false;

    if (cmd.pattern) {
      if (cmd.pattern instanceof RegExp) {
        if (cmd.pattern.test(msg.command)) return true;
      } else {
        if (msg.command === cmd.pattern) return true;
      }
    }

    if (cmd.alias?.map((a) => a.toLowerCase()).includes(msg.command))
      return true;

    return false;
  });
}

export async function loadCommands(
  dir: string = join(import.meta.dir, "commands"),
) {
  const glob = new Bun.Glob("**/*.ts");

  const files = await Array.fromAsync(glob.scan({ cwd: dir, absolute: true }));

  await Promise.all(
    files.map((file) =>
      import(file).catch((err) =>
        console.error(`[plugin] Failed to load command file: ${file}\n`, err),
      ),
    ),
  );

  return {
    commands,
    files,
  };
}
