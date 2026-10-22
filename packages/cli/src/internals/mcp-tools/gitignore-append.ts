import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/** Gitignore entry for pi's directly-written local MCP config (`<project>/.pi/mcp.json`). */
export const PI_MCP_GITIGNORE_ENTRY = ".pi/mcp.json";

/**
 * Appends one gitignore entry to a file, idempotently.
 *
 * Creates the file when it is missing, normalizes a missing trailing newline
 * before appending, and skips the write when the entry is already listed.
 */
export async function appendGitignoreEntry(gitignorePath: string, entry: string): Promise<void> {
  const path = isAbsolute(gitignorePath) ? gitignorePath : resolve(gitignorePath);
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
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
  await writeFile(path, `${base}${entry}\n`, "utf8");
}
