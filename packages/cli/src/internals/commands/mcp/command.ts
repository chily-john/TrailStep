import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@trailstep/mcp";
import type { CliCommand, CliCommandContext } from "../../command-framework/command.types.js";
import { parseCommandFlags } from "../../command-framework/flags.js";

interface McpCommandArgs {
  readonly project?: string;
}

export const mcpCommand: CliCommand<McpCommandArgs> = {
  name: "mcp",
  parseArgs(argv: readonly string[]): McpCommandArgs {
    if (argv[0] !== "mcp") {
      throw new Error("Expected mcp command.");
    }
    const flags = parseCommandFlags(argv.slice(1), {
      commandLabel: "trailstep mcp",
      valueFlags: ["--project"],
      onUnknownFlag: "ignore",
      onMissingValue: "ignore",
      allowEmptyValue: true,
    });
    return flags.project === undefined ? {} : { project: flags.project };
  },
  async run(args: McpCommandArgs, _context: CliCommandContext): Promise<number> {
    // Lazy-load assumption: no full engine init at subcommand startup.
    // Workflow-runtime setup deferred until first run_workflow / first resource
    // (boundary undefined — only deferred trigger added in core).

    // Resolve --project to an absolute directory; the server operates there so
    // project-scoped MCP state (.trailstep/mcp) resolves correctly.
    const projectDir = path.resolve(args.project ?? ".");
    process.chdir(projectDir);

    // Foreground MCP server: the CLI process itself IS the server. The server
    // comes from the @trailstep/mcp package entry (imported by package
    // specifier — never a CWD-relative dist path), and is attached to the CLI
    // process stdio via StdioServerTransport. No detached spawn, no fake
    // {runId,status} quick-return, no startup timeout.
    const server = createServer({ projectDir });
    server.onerror = (error) => {
      process.stderr.write(`trailstep mcp server error: ${error.message}\n`);
    };

    const transport = new StdioServerTransport();
    try {
      await server.connect(transport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`trailstep mcp failed to start: ${message}\n`);
      return 1;
    }

    // Stay foreground: never return while connected. Resolve when the client
    // disconnects — either the server's close hook fires (clean transport
    // close) or stdin ends (client closed its end of the pipe).
    await Promise.race([
      new Promise<void>((resolve) => {
        server.onclose = () => resolve();
      }),
      new Promise<void>((resolve) => {
        process.stdin.once("end", () => resolve());
      }),
    ]);
    return 0;
  },
};
