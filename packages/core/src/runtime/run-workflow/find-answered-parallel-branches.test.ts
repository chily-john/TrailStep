import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAnsweredParallelBranches } from "./run-workflow.js";

describe("findAnsweredParallelBranches (gap 4 routing)", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fapb-"));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("5 same-waitId branches: 3 answered reverse, 2 unanswered (waiting + completed)", async () => {
    const runDir = await mkdtemp(join(tmpDir, "run-"));
    await mkdir(join(runDir, "branches"), { recursive: true });
    await mkdir(join(runDir, "answers"), { recursive: true });

    // track with 5 parallel branches all sharing waitId "approval"
    await writeFile(
      join(runDir, "track.json"),
      JSON.stringify({ splitOccurred: true, branches: ["b1", "b2", "b3", "b4", "b5"] }),
      "utf8"
    );

    // b1, b2, b3 answered (answer artifacts present) — answer in reverse branch order
    for (const id of ["b3", "b2", "b1"]) {
      await writeFile(
        join(runDir, "branches", `${id}.json`),
        JSON.stringify({
          status: "waiting",
          wait: { waitId: "approval", artifactPaths: { answerFile: `answers/${id}.json` } },
        }),
        "utf8"
      );
      await writeFile(join(runDir, "answers", `${id}.json`), JSON.stringify({ approved: true }), "utf8");
    }

    // b4 unanswered: waiting but no answer artifact
    await writeFile(
      join(runDir, "branches", "b4.json"),
      JSON.stringify({
        status: "waiting",
        wait: { waitId: "approval", artifactPaths: { answerFile: "answers/b4.json" } },
      }),
      "utf8"
    );

    // b5 completed sibling — should NOT appear in answered and should not create dirs
    await writeFile(
      join(runDir, "branches", "b5.json"),
      JSON.stringify({ status: "done" }),
      "utf8"
    );

    const answered = await findAnsweredParallelBranches(runDir);
    // 3 answered; order preserved from branches array: b1, b2, b3
    expect(answered).toEqual(["b1", "b2", "b3"]);
    // b4 unanswered stays waiting (not in result)
    expect(answered).not.toContain("b4");
    // b5 completed sibling excluded
    expect(answered).not.toContain("b5");
  });

  it("completed siblings produce no new dirs / no writes", async () => {
    const runDir = await mkdtemp(join(tmpDir, "run-dirs-"));
    await mkdir(join(runDir, "branches"), { recursive: true });
    await writeFile(
      join(runDir, "track.json"),
      JSON.stringify({ splitOccurred: true, branches: ["done1"] }),
      "utf8"
    );
    await writeFile(
      join(runDir, "branches", "done1.json"),
      JSON.stringify({ status: "done" }),
      "utf8"
    );
    const before = (await import("node:fs/promises")).readdir(runDir).catch(() => []);
    const answered = await findAnsweredParallelBranches(runDir);
    expect(answered).toEqual([]);
    // No new directories created; only tracks/branches existed
    const after = await (await import("node:fs/promises")).readdir(runDir);
    const dirs = (await (await import("node:fs/promises")).readdir(runDir, { withFileTypes: true }))
      .filter((e: unknown) => (e as { isDirectory(): boolean }).isDirectory())
      .map((e: unknown) => (e as { name: string }).name);
    expect(dirs.sort()).toEqual(["branches"]);
  });
});
