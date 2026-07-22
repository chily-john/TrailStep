import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CliCommand } from "../../command.types.js";
import { CliInputError } from "../run/load-run-input.js";
import type { CancelCommandArgs } from "./cancel-command.types.js";
import { parseCancelInvocation } from "./parse-cancel-invocation.js";

export const cancelCommand: CliCommand<CancelCommandArgs> = {
  name: "cancel",
  parseArgs: parseCancelInvocation,
  async run(args, context) {
    const interactiveFile = context.env?.STEPKIT_INTERACTIVE_FILE;
    if (!interactiveFile) {
      throw new CliInputError(
        "STEPKIT_INTERACTIVE_FILE is required to cancel an active interactive StepKit session.",
      );
    }

    const protocol = await loadActiveInteractiveSession(interactiveFile);
    await safeWriteJson(interactiveFile, {
      ...protocol,
      status: "cancelled",
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    });
    context.io.writeLine("Interactive session cancelled.");
    return 0;
  },
};

async function loadActiveInteractiveSession(
  interactiveFile: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(interactiveFile, "utf8"));
  } catch (error) {
    throw new CliInputError(`Unable to read active interactive session: ${interactiveFile}`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new CliInputError("Active interactive session file must contain a JSON object.");
  }

  if (parsed.status !== "active") {
    throw new CliInputError("Active interactive session is not active.");
  }

  return parsed;
}

async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
