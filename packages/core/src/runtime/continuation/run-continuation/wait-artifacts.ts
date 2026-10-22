import { readFile } from "node:fs/promises";
import { isNodeError } from "../../../json/guards.js";

export async function readTextIfExists(
  path: string,
): Promise<{ readonly status: "found"; readonly value: string } | { readonly status: "missing" }> {
  try {
    return { status: "found", value: await readFile(path, "utf8") };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
}
