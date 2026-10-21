/**
 * TrailStep MCP server entry (foreground stdio server).
 *
 * Parses `--project <dir>` to an absolute path, connects the low-level server
 * over stdio, and stays alive for the transport lifetime. No detached spawn,
 * no startup timeout, no stdin string matching — the SDK transport owns the
 * JSON-RPC handshake.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio, tools } from "./server.js";

export type { CreateServerOptions, McpToolDefinition } from "./server.js";
export { createServer, serveStdio } from "./server.js";
export {
  loadPerWorkflowTools,
  type PerWorkflowToolDefinition,
  resolvePerWorkflowToolsEnabled,
} from "./tools/per_workflow.js";
// Answer / resume adapters over the real CLI wait-answer and continue seams
// (see ./tools/). Answers are persisted into the run's real wait answer files;
// there is no run_context.json side-channel.
export {
  type TrstAnswerOptions,
  type TrstAnswerResult,
  trstAnswer as trst_answer,
} from "./tools/trst_answer.js";
export {
  type TrstListOptions,
  type TrstListResult,
  type TrstListWorkflowEntry,
  trstList as trst_list,
} from "./tools/trst_list.js";
export {
  type TrstResumeOptions,
  type TrstResumeResult,
  trstResume as trst_resume,
} from "./tools/trst_resume.js";
export {
  type TrstWatchOptions,
  type TrstWatchParams,
  type TrstWatchResult,
  trst_watch,
} from "./tools/trst_watch.js";
export { tools };

interface EntryArgs {
  readonly project?: string;
}

function parseArgs(argv: readonly string[]): EntryArgs {
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && i + 1 < argv.length) {
      project = argv[i + 1];
      i++;
    }
  }
  return { project };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Resolve --project to an absolute path; default to the current directory.
  const projectDir = path.resolve(args.project ?? ".");

  const server = await serveStdio({ projectDir });

  // Stay alive while the stdio transport is open; exit cleanly on signals.
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`trailstep-mcp failed to start: ${message}\n`);
    process.exit(1);
  });
}

// Re-exported tool registry surface (names) for consumers importing the package.
export const toolNames: readonly string[] = tools.map((tool) => tool.name);
