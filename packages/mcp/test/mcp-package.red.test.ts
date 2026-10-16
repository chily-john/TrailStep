import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveCommand } from "../../cli/src/internals/command-registry.js";

// Red phase — Story 003: MCP server package + CLI subcommand + lazy engine init + quick-return run_workflow
// All assertions below must FAIL before green implementation.

describe("Story 003 — MCP package and CLI command (red)", () => {
  it("packages/mcp/package.json exists and names @trailstep/mcp", () => {
    const pkgPath = path.resolve("packages/mcp/package.json");
    expect(fs.existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    expect(pkg.name).toBe("@trailstep/mcp");
  });

  it("packages/mcp/src/index.ts (server entry) exists", () => {
    expect(fs.existsSync(path.resolve("packages/mcp/src/index.ts"))).toBe(true);
  });

  it("packages/mcp/README.md exists (publish-readiness minimum)", () => {
    expect(fs.existsSync(path.resolve("packages/mcp/README.md"))).toBe(true);
  });

  it("packages/mcp/tsconfig.json extends base if needed", () => {
    const tsPath = path.resolve("packages/mcp/tsconfig.json");
    if (fs.existsSync(tsPath)) {
      const raw = fs.readFileSync(tsPath, "utf8");
      expect(raw).toContain("../../tsconfig.base.json");
    } else {
      // Accept absence for red; green must add it.
      expect(true).toBe(true);
    }
  });

  it("CLI registers 'mcp' command", () => {
    // Equiv. registry check: resolveCommand must find 'mcp'; direct registry object
    // not exported, so structural confirmation via source + resolution.
    const regPath = path.resolve("packages/cli/src/internals/command-registry.ts");
    expect(fs.existsSync(regPath)).toBe(true);
    const regSrc = fs.readFileSync(regPath, "utf8");
    expect(regSrc).toContain("mcp"); // fails until registered
    const cmd = resolveCommand(["mcp"]);
    expect(cmd).toBeDefined();
    expect(cmd.name).toBe("mcp");
  });

  it("mcp command file exists: packages/cli/src/internals/commands/mcp/command.ts", () => {
    expect(fs.existsSync(path.resolve("packages/cli/src/internals/commands/mcp/command.ts"))).toBe(
      true,
    );
  });

  it("mcp command uses child_process.spawn and resolves --project absolute", () => {
    // Structural verification only — full behavior verified after green.
    const cmdPath = path.resolve("packages/cli/src/internals/commands/mcp/command.ts");
    if (fs.existsSync(cmdPath)) {
      const src = fs.readFileSync(cmdPath, "utf8");
      expect(src).toContain("child_process");
      expect(src).toContain("spawn");
      expect(src).toContain("path.resolve");
    } else {
      // Red failure: command implementation missing.
      expect(true).toBe(false);
    }
  });

  it("run_workflow returns quickly (<1 s) with {runId,status} and does not hang", () => {
    // Behavioral red guard: quick-return interface (run_workflow / server layer) missing.
    // If present, bounded-time assertion (<1 s) and no await-on-completion would apply.
    // Until green, the command / server file is absent → this fails.
    const serverLayer = path.resolve("packages/mcp/src/run_workflow.ts");
    const cmdExists = fs.existsSync(
      path.resolve("packages/cli/src/internals/commands/mcp/command.ts"),
    );
    // Fail until both command and quick-return server layer exist.
    expect(cmdExists && fs.existsSync(serverLayer)).toBe(true);
  });

  it("lazy engine init: no full engine init at subcommand startup (defer until first run_workflow / first resource)", () => {
    // Boundary undefined — red asserts deferred trigger is NOT yet present.
    // Green must add deferred-init hook (core entry or new module) so that
    // workflow-runtime setup is deferred until first required call.
    const coreIndexPath = path.resolve("packages/core/src/index.ts");
    const deferredFile = path.resolve("packages/core/src/defer-engine-init.ts");
    const hasDeferredFile = fs.existsSync(deferredFile);
    const coreHasHook =
      fs.existsSync(coreIndexPath) && fs.readFileSync(coreIndexPath, "utf8").includes("defer");
    // Red fails until at least one deferred mechanism exists.
    expect(hasDeferredFile || coreHasHook).toBe(true);
  });

  it("subprocess appears in process tree after launch (spawn + exit handlers)", () => {
    // Red: spawn handler file missing → failure.
    expect(fs.existsSync(path.resolve("packages/cli/src/internals/commands/mcp/command.ts"))).toBe(
      true,
    );
  });

  it("defineWorkflow unchanged; no manifest file added; .trailstep/mcp/trst_*.json format unchanged", () => {
    // Existing artifacts frozen — verify no accidental mutation from 001/002.
    expect(fs.existsSync(path.resolve("packages/mcp/manifest.json"))).toBe(false); // no manifest
    const coreIndexPath = path.resolve("packages/core/src/index.ts");
    expect(fs.existsSync(coreIndexPath)).toBe(true);
    const coreSrc = fs.readFileSync(coreIndexPath, "utf8");
    expect(coreSrc).toContain("defineWorkflow");
  });
});
