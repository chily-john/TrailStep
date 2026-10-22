import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectMcpAgentTargets } from "./mcp-agent-targets.js";

describe("detectMcpAgentTargets", () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-"));
    homeDir = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-home-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("detects pi from the project marker at project scope", async () => {
    await mkdir(join(projectDir, ".pi"), { recursive: true });

    expect(await detectMcpAgentTargets({ projectDir, scope: "project" })).toEqual(["pi"]);
  });

  it("treats local scope like project scope for detection", async () => {
    await mkdir(join(projectDir, ".claude"), { recursive: true });

    expect(await detectMcpAgentTargets({ projectDir, scope: "local" })).toEqual(["claude-code"]);
  });

  it("detects nothing for a clean project", async () => {
    expect(await detectMcpAgentTargets({ projectDir, scope: "project" })).toEqual([]);
  });

  it("detects no user-level agents when the global home is clean", async () => {
    expect(await detectMcpAgentTargets({ projectDir, scope: "global", homeDir, env: {} })).toEqual(
      [],
    );
  });

  it("detects user-level agents from markers under the hermetic home dir", async () => {
    await mkdir(join(homeDir, ".cursor"), { recursive: true });
    await mkdir(join(homeDir, ".config", "opencode"), { recursive: true });
    await writeFile(join(homeDir, ".config", "opencode", "opencode.json"), "{}", "utf8");

    expect(await detectMcpAgentTargets({ projectDir, scope: "global", homeDir, env: {} })).toEqual([
      "cursor",
      "opencode",
    ]);
  });

  it("detects pi from the user-level mcp.json under the hermetic home dir", async () => {
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(join(homeDir, ".pi", "agent", "mcp.json"), "{}", "utf8");

    expect(await detectMcpAgentTargets({ projectDir, scope: "global", homeDir, env: {} })).toEqual([
      "pi",
    ]);
  });

  it("honors the PI_CODING_AGENT_DIR env override at user level", async () => {
    const piHome = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-pi-"));
    await writeFile(join(piHome, "mcp.json"), "{}", "utf8");
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { PI_CODING_AGENT_DIR: piHome },
        }),
      ).toEqual(["pi"]);
    } finally {
      await rm(piHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("honors the CODEX_HOME env override at user level", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-codex-"));
    await mkdir(codexHome, { recursive: true });
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { CODEX_HOME: codexHome },
        }),
      ).toEqual(["codex"]);
    } finally {
      await rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("honors the COPILOT_HOME env override at user level", async () => {
    const copilotHome = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-copilot-"));
    await writeFile(join(copilotHome, "mcp.json"), "{}", "utf8");
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { COPILOT_HOME: copilotHome },
        }),
      ).toEqual(["github-copilot-cli"]);
    } finally {
      await rm(copilotHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("honors the GROK_HOME env override at user level", async () => {
    const grokHome = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-grok-"));
    await writeFile(join(grokHome, "mcp.json"), "{}", "utf8");
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { GROK_HOME: grokHome },
        }),
      ).toEqual(["grok-build"]);
    } finally {
      await rm(grokHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("honors the KIMI_CODE_HOME env override at user level", async () => {
    const kimiHome = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-kimi-"));
    await writeFile(join(kimiHome, "mcp.json"), "{}", "utf8");
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { KIMI_CODE_HOME: kimiHome },
        }),
      ).toEqual(["kimi-code"]);
    } finally {
      await rm(kimiHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("repoints XDG-style markers at XDG_CONFIG_HOME when set", async () => {
    const xdgRoot = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-xdg-"));
    await mkdir(join(xdgRoot, "kilo"), { recursive: true });
    await writeFile(join(xdgRoot, "kilo", "mcp.json"), "{}", "utf8");
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { XDG_CONFIG_HOME: xdgRoot },
        }),
      ).toEqual(["kilo-code"]);
    } finally {
      await rm(xdgRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("keeps the app segment under XDG_CONFIG_HOME for goose", async () => {
    const xdgRoot = await mkdtemp(join(tmpdir(), "trst-mcp-agent-targets-xdg-goose-"));
    await mkdir(join(xdgRoot, "goose"), { recursive: true });
    await writeFile(join(xdgRoot, "goose", "config.yaml"), "goose: {}\n", "utf8");
    try {
      expect(
        await detectMcpAgentTargets({
          projectDir,
          scope: "global",
          homeDir,
          env: { XDG_CONFIG_HOME: xdgRoot },
        }),
      ).toEqual(["goose"]);
    } finally {
      await rm(xdgRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("probes the zed user-level config with the Zed directory casing variant", async () => {
    await mkdir(join(homeDir, ".config", "Zed"), { recursive: true });
    await writeFile(join(homeDir, ".config", "Zed", "settings.json"), "{}", "utf8");

    expect(await detectMcpAgentTargets({ projectDir, scope: "global", homeDir, env: {} })).toEqual([
      "zed",
    ]);
  });

  it("detects goose from its global-only user-level config file", async () => {
    await mkdir(join(homeDir, ".config", "goose"), { recursive: true });
    await writeFile(join(homeDir, ".config", "goose", "config.yaml"), "goose: {}\n", "utf8");

    expect(await detectMcpAgentTargets({ projectDir, scope: "global", homeDir, env: {} })).toEqual([
      "goose",
    ]);
  });

  it("detects claude-code from its user-level config file at global scope", async () => {
    await writeFile(join(homeDir, ".claude.json"), "{}", "utf8");

    expect(await detectMcpAgentTargets({ projectDir, scope: "global", homeDir, env: {} })).toEqual([
      "claude-code",
    ]);
  });
});
