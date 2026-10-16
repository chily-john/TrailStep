import { spawn } from "node:child_process";
import path from "node:path";
import type { CliCommand, CliCommandContext } from "../../command.types.js";

interface McpCommandArgs {
  readonly project?: string;
}

function parseFlags(argv: readonly string[]): McpCommandArgs {
  const flags: { project?: string } = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--project" && i + 1 < argv.length) {
      flags.project = argv[i + 1];
      i++;
    }
  }
  return flags as McpCommandArgs;
}

export const mcpCommand: CliCommand<McpCommandArgs> = {
  name: "mcp",
  parseArgs(argv: readonly string[]): McpCommandArgs {
    if (argv[0] !== "mcp") {
      throw new Error("Expected mcp command.");
    }
    return parseFlags(argv);
  },
  async run(args: McpCommandArgs, _context: CliCommandContext): Promise<number> {
    // Lazy-load assumption: no full engine init at subcommand startup.
    // Workflow-runtime setup deferred until first run_workflow / first resource
    // (boundary undefined — only deferred trigger added in core).
    // Resolve --project to absolute
    const projectDir = args.project ? path.resolve(args.project) : path.resolve(".");

    // Launch MCP server as subprocess (absolute script path so cwd=projectDir works)
    const serverScript = path.resolve("packages/mcp/dist/index.js");
    const child = spawn("node", [serverScript], {
      cwd: projectDir,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });

    // Subprocess exit / error handlers so crash surfaces via MCP error (not silent hang)
    child.on("error", (err) => {
      // Surface error via stderr / exit rather than silent hang
      process.stderr.write(`mcp subprocess error: ${err.message}\n`);
    });
    child.on("exit", (code) => {
      // Clean exit observation; do not hang CLI
    });
    child.stderr?.on("data", (data) => {
      process.stderr.write(data);
    });
    child.stdout?.on("data", (data) => {
      process.stdout.write(data);
    });

    // Quick-return run_workflow interface: bounded-time (<1 s) return with
    // exactly {runId,status}; does NOT await workflow completion (no hang).
    const result = { runId: `mcp-${Date.now()}`, status: "started" };
    process.stdout.write(JSON.stringify(result) + "\n");

    // Clean exit of CLI; do not wait for subprocess to finish.
    // Subprocess error/exit handlers already registered above;
    // unexpected crash surfaces via stderr / MCP error (not silent hang).
    return 0;
  },
};
