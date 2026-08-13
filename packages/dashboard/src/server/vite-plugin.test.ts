import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { trailstepDashboardPlugin } from "./vite-plugin";

const workflowStartedEvent = {
  id: "event-1",
  runId: "run-a",
  workflowId: "local-dashboard",
  type: "workflow.started",
  timestamp: "2026-01-02T03:00:00.000Z",
  schemaVersion: "v0",
  payload: {},
};

function createResponse() {
  return {
    statusCode: 0,
    headers: new Map<string, string>(),
    body: "",
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    end(chunk = "") {
      this.body += chunk;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
  };
}

type InstalledMiddleware = (
  request: unknown,
  response: unknown,
  next: () => void,
) => void | Promise<void>;

function installMiddleware(cwd: string) {
  let middleware: InstalledMiddleware | undefined;
  const plugin = trailstepDashboardPlugin({ cwd });
  const configureServer = plugin.configureServer;
  const server = {
    middlewares: {
      use(handler: typeof middleware) {
        middleware = handler;
      },
    },
  } as unknown as ViteDevServer;

  if (typeof configureServer === "function") {
    configureServer(server);
  } else {
    configureServer?.handler(server);
  }

  if (!middleware) {
    throw new Error("dashboard plugin did not install middleware");
  }

  return middleware;
}

describe("TrailStep dashboard Vite plugin", () => {
  it("handles the TrailStep runs API route without retaining the old product route", async ({
    task,
  }) => {
    const cwd = join(process.cwd(), ".tmp", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "run-a");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(workflowStartedEvent)}\n`,
      "utf8",
    );

    const middleware = installMiddleware(cwd);
    const response = createResponse();
    const next = vi.fn();

    await middleware({ method: "GET", url: "/api/trailstep/runs" }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ runs: [{ runId: "run-a" }] });

    const legacyResponse = createResponse();
    const legacyNext = vi.fn();
    const oldProductRoute = `/api/${["step", "kit"].join("")}/runs`;
    await middleware({ method: "GET", url: oldProductRoute }, legacyResponse, legacyNext);
    expect(legacyNext).toHaveBeenCalled();
  });

  it("handles the TrailStep run event stream route", async ({ task }) => {
    vi.useFakeTimers();
    try {
      const cwd = join(process.cwd(), ".tmp", task.id);
      const runDir = join(cwd, ".trailstep", "runs", "run-a");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "events.jsonl"),
        `${JSON.stringify(workflowStartedEvent)}\n`,
        "utf8",
      );

      const middleware = installMiddleware(cwd);
      const response = createResponse();
      const closeHandlers: Array<() => void> = [];
      const request = {
        method: "GET",
        url: "/api/trailstep/runs/run-a/events/stream",
        on(event: string, handler: () => void) {
          if (event === "close") {
            closeHandlers.push(handler);
          }
        },
      };

      await middleware(request, response, vi.fn());
      expect(response.statusCode).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      for (const handler of closeHandlers) {
        handler();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
