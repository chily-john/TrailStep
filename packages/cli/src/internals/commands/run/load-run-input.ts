import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

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
): Promise<PlainObject> {
  if (!input) {
    return {};
  }

  if (input.kind === "inline") {
    return parseJson(input.json, "Invalid JSON supplied to --input.");
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
