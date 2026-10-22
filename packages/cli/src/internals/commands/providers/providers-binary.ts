import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import type { CliCommandContext } from "../../command-framework/command.types.js";

export async function resolveProviderBinary(
  binary: string,
  context: CliCommandContext,
): Promise<boolean> {
  if (context.providerBinaryResolver !== undefined) {
    return context.providerBinaryResolver(binary, context);
  }
  return defaultProviderBinaryResolver(binary, context);
}

async function defaultProviderBinaryResolver(
  binary: string,
  context: CliCommandContext,
): Promise<boolean> {
  const candidates =
    binary.includes("/") || binary.includes("\\")
      ? [resolve(context.cwd, binary)]
      : pathBinaryCandidates(binary, context.env?.PATH ?? process.env.PATH ?? "");
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

function pathBinaryCandidates(binary: string, pathValue: string): readonly string[] {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const names =
    process.platform === "win32" && /\.[^\\/]+$/.test(binary)
      ? [binary]
      : extensions.map((extension) => `${binary}${extension.toLowerCase()}`);
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => names.map((name) => resolve(entry, name)));
}
