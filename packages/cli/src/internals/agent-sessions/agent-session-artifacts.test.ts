import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  type AgentSessionRecord,
  createAgentSessionArtifacts,
  writeAgentSessionRecord,
} from "./agent-session-artifacts.js";

const ARTIFACT_TEST_ROOT = join("node_modules", ".tmp-trailstep-agent-session-artifacts-tests");

beforeEach(async () => {
  await rm(ARTIFACT_TEST_ROOT, { recursive: true, force: true });
});

describe("createAgentSessionArtifacts", () => {
  it("generates collision-safe session directories", async () => {
    const cwd = join(ARTIFACT_TEST_ROOT, "collision-safe");
    const now = () => new Date("2026-01-02T03:04:05.000Z");
    await mkdir(join(cwd, ".trailstep", "sessions", "session-20260102-030405-dupe"), {
      recursive: true,
    });
    const suffixes = ["dupe", "fresh"];

    const artifacts = await createAgentSessionArtifacts({
      cwd,
      now,
      randomSuffix: () => suffixes.shift() ?? "unexpected",
    });

    expect(artifacts.id).toBe("session-20260102-030405-fresh");
    expect(artifacts.dir).toBe(
      join(cwd, ".trailstep", "sessions", "session-20260102-030405-fresh"),
    );
  });

  it("writes initial session metadata before launch", async () => {
    const cwd = join(ARTIFACT_TEST_ROOT, "initial-metadata");
    const artifacts = await createAgentSessionArtifacts({
      cwd,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      randomSuffix: () => "abc123",
    });
    const record: AgentSessionRecord = {
      id: artifacts.id,
      createdAt: "2026-01-02T03:04:05.000Z",
      requestedName: null,
      resolvedTarget: { provider: "claude" },
      provider: "claude",
      launch: { backend: "built-in-provider", mode: "inherited-stdio" },
      paths: {
        sessionJson: artifacts.sessionJsonPath,
        launchPrompt: artifacts.launchPromptPath,
      },
      status: "launching",
    };

    await writeAgentSessionRecord(record);

    await expect(readFile(artifacts.sessionJsonPath, "utf8")).resolves.toContain(
      '"status": "launching"',
    );
  });
});
