import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { stdin } from "node:process";

import type { PlainObject } from "@trailstep/core";

import type { InputSource } from "./run-command.types.js";

export class CliInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliInputError";
  }
}

export async function loadJsonInput(
  input?: InputSource,
  cwd = process.cwd(),
  options: { readonly readStdin?: () => Promise<string> } = {},
): Promise<PlainObject> {
  if (!input) {
    return {};
  }

  if (input.kind === "inline") {
    return parseJson(input.json, "Invalid JSON supplied to --input.");
  }

  if (input.path === "-") {
    let stdinContents: string;

    try {
      stdinContents = await (options.readStdin ?? readProcessStdin)();
    } catch (error) {
      throw new CliInputError("Unable to read input from stdin.", { cause: error });
    }

    return parseJson(stdinContents, "Invalid JSON in stdin input.");
  }

  const inputPath = isAbsolute(input.path) ? input.path : join(cwd, input.path);
  let fileContents: string;

  try {
    fileContents = await readFile(inputPath, "utf8");
  } catch (error) {
    throw new CliInputError(`Unable to read input file: ${input.path}`, { cause: error });
  }

  return parseJson(fileContents, `Invalid JSON in input file: ${input.path}`);
}

async function readProcessStdin(): Promise<string> {
  const chunks: string[] = [];
  stdin.setEncoding("utf8");

  for await (const chunk of stdin) {
    chunks.push(String(chunk));
  }

  return chunks.join("");
}

function parseJson(json: string, message: string): PlainObject {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (isPlainObject(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new CliInputError(message, { cause: error });
  }

  throw new CliInputError(`${message} Expected a JSON object.`);
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
