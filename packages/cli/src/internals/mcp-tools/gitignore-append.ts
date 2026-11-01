import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { isNodeError } from "@trailstep/core";

/** Gitignore entry for pi's directly-written local MCP config (`<project>/.pi/mcp.json`). */
export const PI_MCP_GITIGNORE_ENTRY = ".pi/mcp.json";

/**
 * Appends one gitignore entry to a file, idempotently.
 *
 * Creates the file when it is missing, normalizes a missing trailing newline
 * before appending, and skips the write when the entry is already listed. Only a missing file may
 * be read as "empty": any other read failure must throw, because treating it as empty would
 * replace the user's whole `.gitignore` with this single entry on the next write.
 */
export async function appendGitignoreEntry(gitignorePath: string, entry: string): Promise<void> {
  const path = isAbsolute(gitignorePath) ? gitignorePath : resolve(gitignorePath);
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      // EACCES / EISDIR / EBUSY / EPERM must NEVER be read as "empty": the write below would
      // replace the user's entire .gitignore with a single entry.
      throw new Error(
        `Could not read ${path} to append the gitignore entry: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    content = "";
  }
  const alreadyListed = content.split(/\r?\n/).some((line) => line.trim() === entry);
  if (alreadyListed) {
    return;
  }
  const base =
    content.length === 0 || content.endsWith("\n") || content.endsWith("\r")
      ? content
      : `${content}\n`;
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename so a crash between read and write can't truncate the existing file.
  const next = `${base}${entry}\n`;
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, next, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
