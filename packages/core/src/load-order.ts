import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

function workspaceRoot(): string {
  // Best-effort: cwd or directory containing package.json / .trailstep
  try {
    const cwd = process.cwd();
    if (existsSync(path.join(cwd, ".trailstep")) || existsSync(path.join(cwd, "package.json"))) {
      return cwd;
    }
  } catch {
    /* ignore */
  }
  return process.cwd();
}

export function layeredDirs(): string[] {
  const root = workspaceRoot();
  return [
    path.resolve(root, ".trailstep/mcp/"),
    path.resolve(root, "project/.trailstep/mcp/"),
    path.resolve(homeDir(), ".trailstep/mcp/"),
  ];
}

export function load(options?: { dir?: string; ids?: string[] }): unknown[] {
  const dirs = options?.dir ? [options.dir] : layeredDirs();
  const seenIds = new Set<string>();
  const items: unknown[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const filePath = path.resolve(dir, f);
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        console.error(`Warning: unable to read MCP file ${f}: skip`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        console.error(
          `Warning: skipping malformed MCP file ${f}: ${e instanceof Error ? e.message : e}`,
        );
        continue;
      }
      // First-match wins per file id (basename without .json)
      const id = f.replace(/\.json$/, "");
      if (seenIds.has(id)) continue;
      if (options?.ids && !options.ids.includes(id)) continue;
      seenIds.add(id);
      items.push(parsed);
    }
  }
  return items;
}
