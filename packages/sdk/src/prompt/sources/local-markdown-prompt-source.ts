import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readLocalMarkdownPromptUrl(
  promptUrl: string | URL | undefined,
  stepId: string,
): string {
  if (promptUrl === undefined) {
    throw new TypeError(`Step ${stepId} must declare a promptUrl.`);
  }
  const promptPath = localPromptPath(promptUrl, stepId);
  if (extname(promptPath).toLowerCase() !== ".md") {
    throw new TypeError(`Step ${stepId} promptUrl must point to a local markdown (.md) file.`);
  }
  if (!existsSync(promptPath)) {
    throw new TypeError(`Step ${stepId} promptUrl file does not exist: ${promptPath}`);
  }
  return readFileSync(promptPath, "utf8");
}

function localPromptPath(promptUrl: string | URL, stepId: string): string {
  if (promptUrl instanceof URL) {
    if (promptUrl.protocol !== "file:") {
      throw new TypeError(
        `Step ${stepId} promptUrl must point to a local markdown (.md) file; network URLs are not supported.`,
      );
    }
    return fileURLToPath(promptUrl);
  }
  if (isAbsolute(promptUrl) || /^[a-zA-Z]:[\\/]/u.test(promptUrl)) {
    return resolve(promptUrl);
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(promptUrl);
  } catch {
    return resolve(promptUrl);
  }
  if (parsed.protocol !== "file:") {
    throw new TypeError(
      `Step ${stepId} promptUrl must point to a local markdown (.md) file; network URLs are not supported.`,
    );
  }
  return fileURLToPath(parsed);
}
