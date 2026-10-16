/**
 * TrailStep MCP server.
 *
 * Uses the low-level `Server` from @modelcontextprotocol/sdk with explicit
 * `setRequestHandler` registrations (no zod, no high-level `McpServer`).
 * The `tools` registry below wires every MCP tool (`trst_run_workflow`,
 * `trst_watch`, `trst_answer`, `trst_resume`) with a plain JSON Schema
 * `inputSchema`; CallTool dispatches to the real tool implementations in
 * `tools/` and reports failures as `isError` tool results.
 *
 * Resources: `trailstep://project` (resolved project directory as JSON) and
 * `trailstep://instructions` (generic + static snippet markdown; the project's
 * `.trailstep/mcp/instructions.md` is served when present).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { runWorkflowTool } from "./tools/run_workflow.js";
import { trstAnswer } from "./tools/trst_answer.js";
import { trstResume } from "./tools/trst_resume.js";
import { trst_watch } from "./tools/trst_watch.js";

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

const projectDirProperty = {
  type: "string",
  description:
    "Optional project directory for run resolution. Defaults to the server project directory.",
} as const;

/** Tool registry: every MCP tool with its plain JSON Schema input contract. */
export const tools: readonly McpToolDefinition[] = [
  {
    name: "trst_run_workflow",
    description:
      "Start a TrailStep workflow run in the background and return immediately with {runId, runDir, status}.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          description: "Workflow reference (package id, bundle id, or workflow file path).",
        },
        input: {
          type: "object",
          additionalProperties: true,
          description: "Workflow input; must be a plain JSON object when provided.",
        },
        project: projectDirProperty,
      },
      required: ["workflow"],
    },
  },
  {
    name: "trst_watch",
    description:
      "Observe a TrailStep run's event stream since a byte-offset cursor (persisted across calls) with long-polling.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Run name or run id to observe.",
        },
        cursor: {
          type: "number",
          description:
            "Byte offset into events.jsonl to resume from; overrides the persisted cursor.",
        },
        verbosity: {
          type: "string",
          enum: ["brief", "normal", "full"],
          description:
            "Output verbosity; caps emitted lines at 50 (brief) / 100 (normal) / 200 (full).",
        },
        project: projectDirProperty,
      },
      required: ["runId"],
    },
  },
  {
    name: "trst_answer",
    description:
      "Answer a pending TrailStep wait by persisting the answer into the run's real wait answer file (optionally continuing the run).",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Run name (under the runs root) or run directory path.",
        },
        waitId: {
          type: "string",
          description: "Id of the pending wait to answer.",
        },
        answer: {
          type: "object",
          additionalProperties: true,
          description: "Answer payload persisted verbatim into the wait answer file (JSON object).",
        },
        branchId: {
          type: "string",
          description: "Disambiguates same-id waits pending on parallel branches.",
        },
        continueAfterAnswer: {
          type: "boolean",
          description: "After persisting the answer, run the same continue path trst_resume uses.",
        },
        project: projectDirProperty,
      },
      required: ["runId", "waitId", "answer"],
    },
  },
  {
    name: "trst_resume",
    description:
      "Continue a waiting TrailStep run via the real `trailstep continue` path and report the continue status.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Run name (under the runs root) or run directory path.",
        },
        project: projectDirProperty,
      },
      required: ["runId"],
    },
  },
];

export interface CreateServerOptions {
  /** Project directory the server operates against (already absolute). */
  readonly projectDir?: string;
}

const SERVER_INFO = { name: "trailstep-mcp", version: "0.1.0" } as const;

export const PROJECT_RESOURCE_URI = "trailstep://project";
export const INSTRUCTIONS_RESOURCE_URI = "trailstep://instructions";

/**
 * Fallback instructions content: generic usage guidance plus the static
 * tool-mapping snippet (mirrors `.trailstep/mcp/instructions.md`).
 */
export const INSTRUCTIONS_FALLBACK = `# TrailStep MCP Instructions

## Embedded generic snippet

Usage of \`trst_watch\`, \`trst_answer\`, and \`trst_resume\` for observing and interacting with a running workflow.

## Embedded static snippet

\`\`\`json
{
  "watch": "trst_watch",
  "answer": "trst_answer",
  "resume": "trst_resume"
}
\`\`\`
`;

/** Build the low-level MCP server with ListTools/CallTool/ListResources/ReadResource handlers. */
export function createServer(options: CreateServerOptions = {}): Server {
  const projectDir = options.projectDir ?? path.resolve(".");

  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object" as const,
        properties: tool.inputSchema.properties,
        ...(tool.inputSchema.required ? { required: [...tool.inputSchema.required] } : {}),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return toolError(`Unknown tool: ${name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await dispatchTool(name, args, projectDir);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      return toolError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: PROJECT_RESOURCE_URI,
        name: "TrailStep project",
        description: "The project directory this MCP server operates against.",
        mimeType: "application/json",
      },
      {
        uri: INSTRUCTIONS_RESOURCE_URI,
        name: "TrailStep MCP instructions",
        description: "Generic usage instructions plus the static tool-mapping snippet.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === PROJECT_RESOURCE_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ projectDir }),
          },
        ],
      };
    }
    if (uri === INSTRUCTIONS_RESOURCE_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: readInstructions(projectDir),
          },
        ],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}

/** Connect the server over stdio (foreground; caller owns the process lifetime). */
export async function serveStdio(options: CreateServerOptions = {}): Promise<Server> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

function toolError(text: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * Dispatch a CallTool request to the real tool implementation. Throws on
 * malformed arguments; the CallTool handler converts throws into `isError`
 * tool results.
 */
async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  projectDir: string,
): Promise<unknown> {
  const cwd =
    typeof args.project === "string" && args.project.trim() !== ""
      ? path.resolve(args.project)
      : projectDir;

  switch (name) {
    case "trst_run_workflow": {
      const workflow = readOptionalString(args.workflow) ?? readOptionalString(args.workflowRef);
      if (workflow === undefined) {
        throw new Error("`workflow` must be a non-empty string.");
      }
      const result = await runWorkflowTool({
        workflowRef: workflow,
        ...(args.input === undefined ? {} : { input: args.input }),
        cwd,
      });
      return { ...result, workflow };
    }
    case "trst_watch": {
      return await trst_watch(
        {
          ...(readOptionalString(args.runId) === undefined
            ? {}
            : { runId: readOptionalString(args.runId) }),
          ...(typeof args.cursor === "number" ? { cursor: args.cursor } : {}),
          ...(args.verbosity === "brief" || args.verbosity === "normal" || args.verbosity === "full"
            ? { verbosity: args.verbosity }
            : {}),
        },
        { cwd },
      );
    }
    case "trst_answer": {
      const runId = readOptionalString(args.runId);
      const waitId = readOptionalString(args.waitId);
      if (runId === undefined || waitId === undefined) {
        throw new Error("`runId` and `waitId` must be non-empty strings.");
      }
      if (typeof args.answer !== "object" || args.answer === null || Array.isArray(args.answer)) {
        throw new Error("`answer` must be a JSON object.");
      }
      return await trstAnswer({
        runId,
        waitId,
        answer: args.answer as Record<string, unknown>,
        ...(readOptionalString(args.branchId) === undefined
          ? {}
          : { branchId: readOptionalString(args.branchId) }),
        ...(args.continueAfterAnswer === true ? { continueAfterAnswer: true } : {}),
        cwd,
      });
    }
    case "trst_resume": {
      const runId = readOptionalString(args.runId);
      if (runId === undefined) {
        throw new Error("`runId` must be a non-empty string.");
      }
      return await trstResume({ runId, cwd });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Instructions resource content: the project's `.trailstep/mcp/instructions.md`
 * when present, else the embedded generic + static snippet.
 */
function readInstructions(projectDir: string): string {
  const projectInstructions = path.join(projectDir, ".trailstep", "mcp", "instructions.md");
  if (existsSync(projectInstructions)) {
    try {
      return readFileSync(projectInstructions, "utf8");
    } catch {
      // Fall through to the embedded snippet on any read failure.
    }
  }
  return INSTRUCTIONS_FALLBACK;
}
