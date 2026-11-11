import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { JSONRPCMessage, ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import { tmpProject } from "@trailstep/trailtest";
import { afterAll, describe, expect, it } from "vitest";

import {
  createServer,
  INSTRUCTIONS_FALLBACK,
  INSTRUCTIONS_RESOURCE_URI,
  PROJECT_RESOURCE_URI,
} from "../src/server.js";

// Contract test for the MCP server surface: tool registry wiring, CallTool
// dispatch to the real tool implementations, and the project/instructions
// resources. Uses a real MCP `Client` over the SDK's linked in-memory
// transport (same client API as StdioClientTransport, no process spawn).
// Every sandbox comes from tmpProject(), which cleans itself up on exit.

const clients: Client[] = [];

interface ServerTestOptions {
  readonly progressIntervalMs?: number;
}

async function connectedClient(
  projectDir: string,
  options: ServerTestOptions = {},
): Promise<Client> {
  // Empty tmp home dir keeps the global config/tool JSON layer isolated from
  // the developer's real ~/.trailstep tree.
  const server = createServer({
    projectDir,
    homeDir: tmpProject("mcp-contract-"),
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-contract-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

interface TracedClient {
  readonly client: Client;
  /** Raw progress notifications observed on the server -> client transport. */
  readonly progressNotifications: ProgressNotification[];
  setProgressFailure(value: boolean): void;
}

/**
 * A real server/client pair whose server transport is wrapped so tests can
 * inspect raw progress notifications (the SDK client's onprogress callback
 * strips the token) and inject a progress-delivery failure.
 */
async function connectedTracedClient(
  projectDir: string,
  options: ServerTestOptions = {},
): Promise<TracedClient> {
  const server = createServer({
    projectDir,
    homeDir: tmpProject("mcp-contract-"),
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const progressNotifications: ProgressNotification[] = [];
  let failProgress = false;
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, sendOptions) => {
    if (isProgressNotification(message)) {
      progressNotifications.push(message);
      if (failProgress) {
        throw new Error("simulated progress notification failure");
      }
    }
    return await send(message, sendOptions);
  };

  const client = new Client({ name: "mcp-contract-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return {
    client,
    progressNotifications,
    setProgressFailure: (value) => {
      failProgress = value;
    },
  };
}

function isProgressNotification(message: JSONRPCMessage): message is ProgressNotification {
  return "method" in message && message.method === "notifications/progress";
}

function runEvent(
  type: string,
  payload: Record<string, unknown> = {},
  stepId?: string,
): Record<string, unknown> {
  return {
    id: `evt-${type}`,
    runId: "run-1",
    workflowId: "wf",
    ...(stepId === undefined ? {} : { stepId }),
    type,
    timestamp: new Date(0).toISOString(),
    schemaVersion: "v0",
    payload,
  };
}

/** Writes a run trail (and, by default, a live run lock held by this test process). */
function writeRunTrail(
  projectDir: string,
  runId: string,
  lines: readonly Record<string, unknown>[],
  options: { readonly live?: boolean } = {},
): void {
  const runDir = path.join(projectDir, ".trailstep", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "events.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  if (options.live === false) {
    return;
  }
  fs.writeFileSync(
    path.join(runDir, "run.lock"),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
      nonce: "mcp-contract-live-lock",
    }),
    "utf8",
  );
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for test condition");
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.text ?? "";
}

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
});

describe("MCP server contract", () => {
  it("lists all four tools with object input schemas and required fields", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["trst_answer", "trst_resume", "trst_run_workflow", "trst_watch"]);

    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const required = Object.fromEntries(
      listed.tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]),
    );
    expect(required.trst_run_workflow).toContain("workflow");
    expect(required.trst_watch).toContain("runId");
    expect(required.trst_answer).toEqual(expect.arrayContaining(["runId", "waitId", "answer"]));
    expect(required.trst_resume).toContain("runId");
  });

  it("describes the per-workflow tool preference and the watch loop in the tool descriptions", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const listed = await client.listTools();
    const descriptions = Object.fromEntries(
      listed.tools.map((tool) => [tool.name, tool.description ?? ""]),
    );

    expect(descriptions.trst_run_workflow).toContain("per-workflow tool");
    expect(descriptions.trst_run_workflow).toContain("trst_delegate");
    expect(descriptions.trst_run_workflow).toContain("trst_watch");
    expect(descriptions.trst_run_workflow).toContain(
      "blocks until the run settles, needs an answer, new events arrive, or the budget expires",
    );
    expect(descriptions.trst_run_workflow).not.toContain(
      "blocks until the run finishes or needs an answer",
    );
    expect(descriptions.trst_watch).toContain("Blocking wait-for-attention");
    expect(descriptions.trst_watch).toContain("one call blocks until one of four things happens");
    expect(descriptions.trst_watch).toContain("the run settles (terminal or crashed)");
    expect(descriptions.trst_watch).toContain("it needs an answer (waiting)");
    expect(descriptions.trst_watch).toContain("new events arrive");
    expect(descriptions.trst_watch).toContain("the budget expires");
    expect(descriptions.trst_watch).not.toContain("blocks until the run finishes or needs you");
    expect(descriptions.trst_watch).not.toContain("covers the whole budget");
    expect(descriptions.trst_watch).toContain("persisted per-run cursor");
    expect(descriptions.trst_watch).toContain("trst_answer");
    expect(descriptions.trst_watch).toContain("trst_resume");
    expect(descriptions.trst_watch).toContain("Required: runId");
    expect(descriptions.trst_watch).toContain("maxWaitMs");
    expect(descriptions.trst_watch).toContain("waitFor");
    for (const state of ["started", "in-progress", "waiting", "terminal", "crashed"]) {
      expect(descriptions.trst_watch).toContain(state);
    }
    expect(descriptions.trst_watch).toContain("branchId");
    expect(descriptions.trst_watch).toContain("do not poll in a loop");
    expect(descriptions.trst_watch).toContain("25 s");
    expect(descriptions.trst_watch).toContain("effectiveWaitMs");
    expect(descriptions.trst_watch).toContain("no live process holds the run");
    expect(descriptions.trst_watch).toContain("cancelled run may carry neither");
    expect(descriptions.trst_watch).toContain(
      "client may treat progress notifications as a keep-alive",
    );
    expect(descriptions.trst_watch).not.toContain("server keeps the request alive");
    expect(descriptions.trst_watch).not.toContain("notifications reset");
    expect(descriptions.trst_watch).toContain("startup grace");
    expect(descriptions.trst_watch).toContain("no events and no live process");
    expect(descriptions.trst_answer).toContain("Required: runId");
    expect(descriptions.trst_answer).toContain("Required: runId and waitId");
    expect(descriptions.trst_answer).toContain("plain JSON object");
    expect(descriptions.trst_answer).toContain("continueAfterAnswer");
    expect(descriptions.trst_resume).toContain("Required: runId");
    expect(descriptions.trst_resume).toContain("status");
    expect(descriptions.trst_resume).toContain("in the background");
    expect(descriptions.trst_resume).toContain("trst_watch");
    expect(descriptions.trst_resume).toContain(
      "blocks until the run settles, needs an answer, new events arrive, or the budget expires",
    );
    expect(descriptions.trst_resume).not.toContain(
      "blocks until the run finishes or needs an answer",
    );

    const watch = listed.tools.find((tool) => tool.name === "trst_watch");
    const properties = (watch?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;
    expect(properties.maxWaitMs?.description).toContain("300000");
    expect(properties.maxWaitMs?.description).toContain("5 minutes");
    expect(properties.maxWaitMs?.description).toContain("single-shot");
    expect(properties.maxWaitMs?.description).toContain("25 s");
    expect(properties.maxWaitMs?.description).toContain("state depends on the run");
    expect(properties.maxWaitMs?.description).not.toContain("in-progress snapshot");
    expect(properties.waitFor?.description).toContain("at call start");
    expect(properties.waitFor?.description).toContain("subsequent new event");
    expect(properties.waitFor?.description).toContain("deadline");
    expect(properties.waitFor?.description).toContain("waits[]");
    expect(properties.waitFor?.description).not.toContain("ignores pending waits");
  });

  it("sends server instructions that point at the instructions resource", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const instructions = client.getInstructions();
    expect(instructions).toContain(INSTRUCTIONS_RESOURCE_URI);
    expect(instructions).toContain("trst_run_workflow");
    expect(instructions).toContain("trst_watch");
    expect(instructions).toContain("trst_answer");
    expect(instructions).toContain("trst_resume");
    expect(instructions).toContain("waiting");
    expect(instructions).toContain("in-progress");
    expect(instructions).toMatch(/do not poll in a loop/iu);
    expect(instructions).toContain("the run settles");
    expect(instructions).toContain("needs an answer");
    expect(instructions).toContain("new events arrive");
    expect(instructions).toContain("budget expires");
    expect(instructions).toContain("cancelled run may carry neither");
    expect(instructions).toContain("client may treat progress notifications as a keep-alive");
    expect(instructions).not.toContain("keeps the request alive");
    expect(instructions).not.toContain("notifications reset client request timeouts");
  });

  it("trst_run_workflow rejects a missing workflow without spawning", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const call = await client.callTool({ name: "trst_run_workflow", arguments: {} });
    expect(call.isError).toBe(true);
    expect(firstText(call)).toContain("workflow");
  });

  it("trst_run_workflow surfaces status 'failed' as an isError result with the JSON payload", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    // A configured-but-missing CLI entry can never start a run; the tool
    // reports status "failed" and the server must surface it as isError
    // (failures are isError results; a started run is plain content).
    const savedCliEntry = process.env.TRAILSTEP_CLI_ENTRY;
    process.env.TRAILSTEP_CLI_ENTRY = path.join(
      tmpProject("mcp-contract-"),
      "no-such-cli-entry.js",
    );
    try {
      const call = await client.callTool({
        name: "trst_run_workflow",
        arguments: { workflow: "flows/demo" },
      });
      expect(call.isError).toBe(true);
      const payload = JSON.parse(firstText(call)) as {
        status?: unknown;
        error?: unknown;
        workflow?: unknown;
      };
      expect(payload.status).toBe("failed");
      expect(typeof payload.error).toBe("string");
      expect(payload.workflow).toBe("flows/demo");
    } finally {
      if (savedCliEntry === undefined) {
        delete process.env.TRAILSTEP_CLI_ENTRY;
      } else {
        process.env.TRAILSTEP_CLI_ENTRY = savedCliEntry;
      }
    }
  });

  it("trst_answer dispatches to the real adapter and reports unresolved waits", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const call = await client.callTool({
      name: "trst_answer",
      arguments: { runId: "no-such-run", waitId: "wait-1", answer: { decision: "yes" } },
    });
    // An unanswered / unresolvable wait is a failure: the answer never
    // persisted, so the tool result must surface it as an isError result
    // (consistent with the run_workflow status:"failed" convention).
    expect(call.isError).toBe(true);
    const payload = JSON.parse(firstText(call)) as { persisted?: unknown; error?: unknown };
    expect(payload.persisted).toBe(false);
    expect(typeof payload.error).toBe("string");
  });

  it("trst_answer surfaces a failed continue as an isError result, not plain success", async () => {
    const projectDir = tmpProject("mcp-contract-");
    const runDir = path.join(projectDir, ".trailstep", "runs", "waiting-run");
    fs.mkdirSync(runDir, { recursive: true });
    const line = (type: string, payload: Record<string, unknown>): string =>
      JSON.stringify({
        id: `evt-${type}`,
        runId: "waiting-run",
        workflowId: "wf",
        type,
        timestamp: new Date(0).toISOString(),
        schemaVersion: "v0",
        payload,
      });
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      `${[
        line("workflow.started", { workflowRef: "./wf.mjs#w" }),
        line("wait.started", {
          waitId: "wait-1",
          kind: "input",
          message: "Need a value",
          artifactPaths: {
            requestFile: "waits/wait-1.request.json",
            answerFile: "waits/wait-1.answer.json",
          },
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    // A continue that dies before producing events: the answer persisted, but the
    // run is not moving, so reporting success would leave the calling agent
    // watching a run that can never progress.
    const failingCli = path.join(projectDir, "failing-continue.mjs");
    fs.writeFileSync(failingCli, "process.exit(7);\n", "utf8");

    const savedCliEntry = process.env.TRAILSTEP_CLI_ENTRY;
    process.env.TRAILSTEP_CLI_ENTRY = failingCli;
    try {
      const client = await connectedClient(projectDir);
      const call = await client.callTool({
        name: "trst_answer",
        arguments: {
          runId: "waiting-run",
          waitId: "wait-1",
          answer: { decision: "yes" },
          continueAfterAnswer: true,
        },
      });

      expect(call.isError).toBe(true);
      const payload = JSON.parse(firstText(call)) as {
        persisted?: unknown;
        continued?: { resumed?: unknown; error?: unknown };
      };
      expect(payload.persisted).toBe(true);
      expect(payload.continued?.resumed).toBe(false);
      expect(typeof payload.continued?.error).toBe("string");
    } finally {
      if (savedCliEntry === undefined) {
        delete process.env.TRAILSTEP_CLI_ENTRY;
      } else {
        process.env.TRAILSTEP_CLI_ENTRY = savedCliEntry;
      }
    }
  }, 20_000);

  it("trst_resume dispatches to the real adapter and reports unresolved runs", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const call = await client.callTool({
      name: "trst_resume",
      arguments: { runId: "no-such-run" },
    });
    // A run that could not be resolved / continued is a failure: the resume
    // did not succeed, so the tool result must surface it as an isError result
    // (consistent with the run_workflow status:"failed" convention).
    expect(call.isError).toBe(true);
    const payload = JSON.parse(firstText(call)) as { resumed?: unknown; error?: unknown };
    expect(payload.resumed).toBe(false);
    expect(typeof payload.error).toBe("string");
  });

  it("trst_watch surfaces a missing run as an isError tool result", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const call = await client.callTool({
      name: "trst_watch",
      arguments: { runId: "no-such-run", verbosity: "brief" },
    });
    expect(call.isError).toBe(true);
    expect(firstText(call)).toContain("trst_watch");
  });

  it("reports an empty trail as started inside the startup grace window and crashed after it", async () => {
    const projectDir = tmpProject("mcp-contract-");
    writeRunTrail(projectDir, "run-fresh", [], { live: false });
    const staleRunDir = path.join(projectDir, ".trailstep", "runs", "run-stale");
    fs.mkdirSync(staleRunDir, { recursive: true });
    const staleEvents = path.join(staleRunDir, "events.jsonl");
    fs.writeFileSync(staleEvents, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(staleEvents, old, old);

    const client = await connectedClient(projectDir);
    const fresh = await client.callTool({
      name: "trst_watch",
      arguments: { runId: "run-fresh", maxWaitMs: 0 },
    });
    expect(fresh.isError).toBeFalsy();
    expect((JSON.parse(firstText(fresh)) as { state?: string }).state).toBe("started");

    const stale = await client.callTool({
      name: "trst_watch",
      arguments: { runId: "run-stale", maxWaitMs: 0 },
    });
    expect(stale.isError).toBeFalsy();
    const payload = JSON.parse(firstText(stale)) as {
      state?: string;
      crash?: { reason?: string };
    };
    expect(payload.state).toBe("crashed");
    expect(payload.crash?.reason).toBe("run has no events and no live process");
  });

  it("rejects unknown tools as isError results, not silent hangs", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const call = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(call.isError).toBe(true);
    expect(firstText(call)).toContain("Unknown tool");
  });

  it("emits notifications/progress with the request token for a progress-capable watch", async () => {
    const projectDir = tmpProject("mcp-progress-");
    writeRunTrail(projectDir, "run-progress", [
      runEvent("workflow.started"),
      runEvent("step.started", {}, "delegate-turn"),
    ]);
    const traced = await connectedTracedClient(projectDir, { progressIntervalMs: 80 });
    // Advance the cursor so the token-bearing call below actually long-polls
    // instead of returning immediately because it consumed new events.
    await traced.client.callTool({
      name: "trst_watch",
      arguments: { runId: "run-progress", maxWaitMs: 0 },
    });
    let callbacks = 0;
    const call = await traced.client.callTool(
      { name: "trst_watch", arguments: { runId: "run-progress", maxWaitMs: 600 } },
      undefined,
      {
        onprogress: () => {
          callbacks += 1;
        },
      },
    );

    expect(call.isError).toBeFalsy();
    const payload = JSON.parse(firstText(call)) as {
      state?: string;
      effectiveWaitMs?: number;
    };
    expect(payload.state).toBe("in-progress");
    expect(payload.effectiveWaitMs).toBe(600);
    // The SDK only invokes onprogress for a notification whose token matches
    // the request's registered token, so callbacks prove token matching too.
    expect(callbacks).toBeGreaterThanOrEqual(2);
    expect(traced.progressNotifications.length).toBeGreaterThanOrEqual(2);

    const tokens = new Set(
      traced.progressNotifications.map((notification) => notification.params.progressToken),
    );
    expect(tokens.size).toBe(1);
    for (const notification of traced.progressNotifications) {
      expect(notification.params.total).toBe(1);
      expect(notification.params.message).toBe("state=in-progress step=delegate-turn");
    }
    const values = traced.progressNotifications.map((notification) => notification.params.progress);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index] ?? 0).toBeGreaterThanOrEqual(values[index - 1] ?? 0);
    }
  });

  it("sanitizes control characters and NEL out of progress messages", async () => {
    const projectDir = tmpProject("mcp-progress-");
    const stepId = "delegate\u0000turn\u001b[31m\u0085next";
    writeRunTrail(projectDir, "run-controls", [
      runEvent("workflow.started"),
      runEvent("step.started", {}, stepId),
    ]);
    const traced = await connectedTracedClient(projectDir, { progressIntervalMs: 40 });
    await traced.client.callTool({
      name: "trst_watch",
      arguments: { runId: "run-controls", maxWaitMs: 0 },
    });
    await traced.client.callTool(
      { name: "trst_watch", arguments: { runId: "run-controls", maxWaitMs: 600 } },
      undefined,
      { onprogress: () => undefined },
    );

    expect(traced.progressNotifications.length).toBeGreaterThanOrEqual(1);
    for (const notification of traced.progressNotifications) {
      const message = notification.params.message ?? "";
      expect(message).not.toMatch(/\p{Cc}/u);
      expect(message.split("\n")).toHaveLength(1);
    }
  });

  it("omits the step field when a step id is only whitespace or control characters", async () => {
    const projectDir = tmpProject("mcp-progress-");
    writeRunTrail(projectDir, "run-blank", [
      runEvent("workflow.started"),
      runEvent("step.started", {}, " \u0000 \u001b "),
    ]);
    const traced = await connectedTracedClient(projectDir, { progressIntervalMs: 40 });
    await traced.client.callTool({
      name: "trst_watch",
      arguments: { runId: "run-blank", maxWaitMs: 0 },
    });
    await traced.client.callTool(
      { name: "trst_watch", arguments: { runId: "run-blank", maxWaitMs: 600 } },
      undefined,
      { onprogress: () => undefined },
    );

    expect(traced.progressNotifications.length).toBeGreaterThanOrEqual(1);
    for (const notification of traced.progressNotifications) {
      expect(notification.params.message).toBe("state=in-progress");
    }
  });

  it("emits nothing and clamps a token-less watch to the 25 s ceiling", async () => {
    const projectDir = tmpProject("mcp-progress-");
    writeRunTrail(
      projectDir,
      "run-completed",
      [runEvent("workflow.started"), runEvent("workflow.completed", { output: { ok: true } })],
      { live: false },
    );
    const traced = await connectedTracedClient(projectDir, { progressIntervalMs: 40 });
    const call = await traced.client.callTool({
      name: "trst_watch",
      arguments: { runId: "run-completed" },
    });

    expect(call.isError).toBeFalsy();
    const payload = JSON.parse(firstText(call)) as {
      state?: string;
      effectiveWaitMs?: number;
      output?: unknown;
    };
    expect(payload.state).toBe("terminal");
    expect(payload.effectiveWaitMs).toBe(25_000);
    expect(payload.output).toEqual({ ok: true });
    expect(traced.progressNotifications).toEqual([]);
  });

  it("does not emit progress for tools other than trst_watch", async () => {
    const projectDir = tmpProject("mcp-progress-");
    const traced = await connectedTracedClient(projectDir);
    const call = await traced.client.callTool(
      { name: "trst_resume", arguments: { runId: "no-such-run" } },
      undefined,
      { onprogress: () => undefined },
    );

    expect(call.isError).toBe(true);
    expect(traced.progressNotifications).toEqual([]);
  });

  it("uses the 300 s ceiling and reports it in the total when a token is present", async () => {
    const projectDir = tmpProject("mcp-progress-");
    writeRunTrail(
      projectDir,
      "run-completed",
      [runEvent("workflow.started"), runEvent("workflow.completed", { output: { ok: true } })],
      { live: false },
    );
    const traced = await connectedTracedClient(projectDir);
    const call = await traced.client.callTool(
      { name: "trst_watch", arguments: { runId: "run-completed" } },
      undefined,
      { onprogress: () => undefined },
    );

    const payload = JSON.parse(firstText(call)) as { effectiveWaitMs?: number };
    expect(payload.effectiveWaitMs).toBe(300_000);
    expect(traced.progressNotifications.length).toBeGreaterThanOrEqual(1);
    for (const notification of traced.progressNotifications) {
      expect(notification.params.total).toBe(300);
    }
  });

  it("swallows a rejected progress notification and still returns the watch result", async () => {
    const projectDir = tmpProject("mcp-progress-");
    writeRunTrail(
      projectDir,
      "run-completed",
      [runEvent("workflow.started"), runEvent("workflow.completed", { output: { ok: true } })],
      { live: false },
    );
    const traced = await connectedTracedClient(projectDir);
    traced.setProgressFailure(true);
    let callbacks = 0;
    const call = await traced.client.callTool(
      { name: "trst_watch", arguments: { runId: "run-completed", maxWaitMs: 0 } },
      undefined,
      {
        onprogress: () => {
          callbacks += 1;
        },
      },
    );

    expect(call.isError).toBeFalsy();
    expect((JSON.parse(firstText(call)) as { state?: string }).state).toBe("terminal");
    expect(traced.progressNotifications).toHaveLength(1);
    expect(callbacks).toBe(0);
  });

  it("forwards cancellation: stops notifications and returns through the persist path", async () => {
    const projectDir = tmpProject("mcp-progress-");
    const runDir = path.join(projectDir, ".trailstep", "runs", "run-abort");
    fs.mkdirSync(runDir, { recursive: true });
    // Empty trail + no cursor: the watch has nothing new to consume, so it
    // long-polls until the request is cancelled.
    fs.writeFileSync(path.join(runDir, "events.jsonl"), "", "utf8");
    const server: Server = createServer({
      projectDir,
      homeDir: tmpProject("mcp-contract-"),
      progressIntervalMs: 40,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const received: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => {
      received.push(message);
    };

    try {
      await server.connect(serverTransport);
      const progressMessages = (): ProgressNotification[] =>
        received.filter((message): message is ProgressNotification =>
          isProgressNotification(message),
        );

      await clientTransport.send({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: {
          name: "trst_watch",
          arguments: { runId: "run-abort", maxWaitMs: 5000 },
          _meta: { progressToken: "abort-token" },
        },
      });

      await waitFor(() => progressMessages().length >= 2 || undefined);
      expect(
        progressMessages().every(
          (notification) => notification.params.progressToken === "abort-token",
        ),
      ).toBe(true);

      await clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 77, reason: "test abort" },
      });
      const countAtAbort = progressMessages().length;
      const cancelledAt = Date.now();

      // The SDK suppresses the JSON-RPC response for an aborted request, so the
      // observable proof that the handler returned normally (rather than
      // hanging) is its cursor write. The normal snapshot shape itself is
      // covered by trst-watch.test.ts.
      const cursorFile = path.join(projectDir, ".trailstep", "mcp", ".cursor", "run-abort.json");
      await waitFor(() => (fs.existsSync(cursorFile) ? true : undefined), 1000);
      expect(Date.now() - cancelledAt).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(progressMessages().length).toBe(countAtAbort);
      expect(JSON.parse(fs.readFileSync(cursorFile, "utf8"))).toEqual({
        runId: "run-abort",
        cursor: 0,
      });
      expect(received.some((message) => "id" in message && message.id === 77)).toBe(false);
    } finally {
      await clientTransport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("trailstep://project resource reports the resolved project directory", async () => {
    const projectDir = tmpProject("mcp-contract-");
    const client = await connectedClient(projectDir);
    const resource = await client.readResource({ uri: PROJECT_RESOURCE_URI });
    const text = resource.contents[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ projectDir });
  });

  it("trailstep://instructions resource serves the generic + static snippet", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const resource = await client.readResource({ uri: INSTRUCTIONS_RESOURCE_URI });
    const text = resource.contents[0]?.text ?? "";
    expect(text).toContain("generic");
    expect(text).toContain('"watch": "trst_watch"');
    expect(text).toContain('"answer": "trst_answer"');
    expect(text).toContain('"resume": "trst_resume"');
  });

  it("trailstep://instructions serves the project's instructions.md when present", async () => {
    const projectDir = tmpProject("mcp-contract-");
    const instructionsPath = path.join(projectDir, ".trailstep", "mcp", "instructions.md");
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    fs.writeFileSync(instructionsPath, "# Project instructions marker\n", "utf8");

    const client = await connectedClient(projectDir);
    const resource = await client.readResource({ uri: INSTRUCTIONS_RESOURCE_URI });
    expect(resource.contents[0]?.text).toContain("Project instructions marker");
  });

  it("lists both project and instructions resources", async () => {
    const client = await connectedClient(tmpProject("mcp-contract-"));
    const listed = await client.listResources();
    const uris = listed.resources.map((resource) => resource.uri).sort();
    expect(uris).toEqual([PROJECT_RESOURCE_URI, INSTRUCTIONS_RESOURCE_URI].sort());
  });

  it("fallback instructions carry generic + static snippet with no broken embeds", () => {
    // The repo .trailstep/mcp/instructions.md is git-ignored local state, so assert
    // the committed fallback instead. When the local file exists (e.g. after
    // `trailstep add`), it must carry the same snippets.
    expect(INSTRUCTIONS_FALLBACK).toContain("Embedded generic snippet");
    expect(INSTRUCTIONS_FALLBACK).toContain("Embedded static snippet");
    expect(INSTRUCTIONS_FALLBACK).toContain("trst_run_workflow");
    expect(INSTRUCTIONS_FALLBACK).toContain("trst_watch");
    expect(INSTRUCTIONS_FALLBACK).toContain("trst_answer");
    expect(INSTRUCTIONS_FALLBACK).toContain("trst_resume");
    expect(INSTRUCTIONS_FALLBACK).toContain("trst_list");
    expect(INSTRUCTIONS_FALLBACK).toContain('"watch": "trst_watch"');
    expect(INSTRUCTIONS_FALLBACK).toContain('"answer": "trst_answer"');
    expect(INSTRUCTIONS_FALLBACK).toContain('"resume": "trst_resume"');
    expect(INSTRUCTIONS_FALLBACK).not.toContain("embed failed");
    expect(INSTRUCTIONS_FALLBACK).toContain("the run settles, needs an answer, new events arrive");
    expect(INSTRUCTIONS_FALLBACK).toContain("cancelled run may carry neither");
    expect(INSTRUCTIONS_FALLBACK).toContain(
      "client may treat progress notifications as a keep-alive",
    );
    expect(INSTRUCTIONS_FALLBACK).not.toContain("keep the request alive");
    expect(INSTRUCTIONS_FALLBACK).not.toContain("blocks until the run finishes or needs an answer");
    expect(INSTRUCTIONS_FALLBACK).not.toContain("in-progress snapshot");

    // The README is an agent-facing surface too; keep it honest about the same
    // four early-return conditions, cancelled runs, and client-neutral progress.
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      "one call blocks until the run settles, needs an answer, new events arrive, or the budget expires",
    );
    expect(readme).toContain("cancelled run may carry none");
    expect(readme).toContain("client may treat those notifications as a keep-alive");
    expect(readme).not.toContain("one call covers the whole budget");
    expect(readme).not.toContain("exactly one of `output`");
    expect(readme).not.toContain("because the notifications reset client request timeouts");
    expect(readme).not.toContain("in-progress snapshot");

    const instructionsPath = path.resolve(".trailstep/mcp/instructions.md");
    if (fs.existsSync(instructionsPath)) {
      const content = fs.readFileSync(instructionsPath, "utf8");
      expect(content).toContain("Embedded generic snippet");
      expect(content).toContain("Embedded static snippet");
      expect(content).toContain('"watch": "trst_watch"');
      expect(content).toContain('"answer": "trst_answer"');
      expect(content).toContain('"resume": "trst_resume"');
      expect(content).not.toContain("embed failed");
    }
  });
});
