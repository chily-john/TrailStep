import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layeredMcpToolDirs, loadLayeredMcpToolDefinitions } from "./layered-mcp-loader.js";

// Focused tests for layered MCP config loading. Layered artifacts are written
// only under per-test tmp directories (the real home/global layer is never
// written to).

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "trst-load-order-test-"));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

describe("layered mcp tool loader", () => {
  it("resolves the global layer under os.homedir() (not HOME/USERPROFILE/~ fallbacks)", () => {
    const dirs = layeredMcpToolDirs();
    expect(dirs).toHaveLength(3);
    expect(dirs[2]).toBe(path.resolve(homedir(), ".trailstep/mcp/"));
    expect(dirs[2]?.startsWith(homedir())).toBe(true);
  });

  it("anchors local and project layers to an explicit projectDir, keeping local > project > global", () => {
    const projectDir = tmpRoot();
    const dirs = layeredMcpToolDirs({ projectDir });
    expect(dirs).toEqual([
      path.resolve(projectDir, ".trailstep/mcp/"),
      path.resolve(projectDir, "project/.trailstep/mcp/"),
      path.resolve(homedir(), ".trailstep/mcp/"),
    ]);
  });

  it("first match wins per basename across layers (local beats project)", () => {
    const projectDir = tmpRoot();
    const localDir = path.join(projectDir, ".trailstep", "mcp");
    const projectLayerDir = path.join(projectDir, "project", ".trailstep", "mcp");
    mkdirSync(localDir, { recursive: true });
    mkdirSync(projectLayerDir, { recursive: true });

    const id = "trst-load-order-layer-test";
    writeFileSync(path.join(localDir, `${id}.json`), JSON.stringify({ layer: "local" }), "utf8");
    writeFileSync(
      path.join(projectLayerDir, `${id}.json`),
      JSON.stringify({ layer: "project" }),
      "utf8",
    );

    expect(loadLayeredMcpToolDefinitions({ projectDir, ids: [id] })).toEqual([{ layer: "local" }]);

    rmSync(path.join(localDir, `${id}.json`));
    expect(loadLayeredMcpToolDefinitions({ projectDir, ids: [id] })).toEqual([
      { layer: "project" },
    ]);
  });

  it("skips malformed JSON with a stderr warning and keeps loading the rest", () => {
    const dir = path.join(tmpRoot(), "mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "broken.json"), "{ not json", "utf8");
    writeFileSync(path.join(dir, "good.json"), JSON.stringify({ ok: true }), "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const items = loadLayeredMcpToolDefinitions({ dir });

    expect(items).toEqual([{ ok: true }]);
    expect(errorSpy).toHaveBeenCalled();
    const warning = String(errorSpy.mock.calls[0]?.[0] ?? "");
    expect(warning).toMatch(/malformed/u);
    expect(warning).toMatch(/broken\.json/u);
  });
});
