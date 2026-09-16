import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDeterministicContextPreflightBrief } from "./step.js";

describe("buildDeterministicContextPreflightBrief", () => {
  it("extracts bounded deterministic context without blocking on missing context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-context-preflight-"));
    await mkdir(join(cwd, "packages", "create-flows"), { recursive: true });
    await writeFile(
      join(cwd, "packages", "create-flows", "package.json"),
      JSON.stringify({ name: "@trailstep/create-flows" }),
      "utf8",
    );

    const brief = await buildDeterministicContextPreflightBrief({
      cwd,
      currentStory: {
        path: join(cwd, "docs", "story.md"),
        content: [
          "## Story 001: Deterministic preflight",
          "",
          "Touch `ContextPreflightStep` in packages/create-flows/src/feature-implementation/story-isolation-preflight/step.ts.",
          "",
          "## Acceptance Criteria",
          "- Preflight produces likely files and validation hints.",
          "",
          "## Validation Commands",
          "- pnpm --filter @trailstep/create-flows test",
        ].join("\n"),
      },
      implementationContext: "Use package-local checks only.",
    });

    expect(brief.blocked).toBe(false);
    expect(brief.relevantFiles).toContain("docs/story.md");
    expect(brief.relevantFiles).toContain(
      "packages/create-flows/src/feature-implementation/story-isolation-preflight/step.ts",
    );
    expect(brief.packageHints).toContain("@trailstep/create-flows");
    expect(brief.symbols).toContain("ContextPreflightStep");
    expect(brief.recommendedValidationCommands).toContain(
      "pnpm --filter @trailstep/create-flows test",
    );
    expect(brief.summary).toContain("Use package-local checks only.");
  });
});
