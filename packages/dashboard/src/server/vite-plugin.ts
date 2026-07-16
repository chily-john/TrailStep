import { resolve, sep } from "node:path";

import type { Plugin } from "vite";

import { streamRunEvents } from "./events";
import { listRuns } from "./runs";

export function stepkitDashboardPlugin(options: { readonly cwd?: string } = {}): Plugin {
  const cwd = options.cwd ?? process.cwd();

  return {
    name: "stepkit-dashboard-local-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url) {
          next();
          return;
        }

        const url = new URL(request.url, "http://localhost");

        if (request.method === "GET" && url.pathname === "/api/stepkit/runs") {
          const runs = await listRuns({ cwd });
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ runs }));
          return;
        }

        const match = url.pathname.match(/^\/api\/stepkit\/runs\/([^/]+)\/events\/stream$/);
        if (request.method === "GET" && match?.[1]) {
          const runId = decodeURIComponent(match[1]);
          const runDir = resolve(cwd, ".stepkit", "runs", runId);
          const runsRoot = resolve(cwd, ".stepkit", "runs");

          if (!runDir.startsWith(`${runsRoot}${sep}`) && runDir !== runsRoot) {
            response.statusCode = 400;
            response.end("Invalid run id");
            return;
          }

          response.statusCode = 200;
          response.setHeader("Content-Type", "text/event-stream");
          response.setHeader("Cache-Control", "no-cache, no-transform");
          response.setHeader("Connection", "keep-alive");
          response.write("retry: 1000\n\n");

          const close = streamRunEvents({ runDir, response });
          request.on("close", close);
          return;
        }

        next();
      });
    },
  };
}
