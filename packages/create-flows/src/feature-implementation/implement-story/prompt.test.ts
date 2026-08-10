import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("story implementation contract", () => {
  it("uses TrailStep naming in workflow guidance and implementation doc markers", async () => {
    const storyContract = await readFile(
      join(import.meta.dirname, "../shared/story-implementation-contract.md"),
      "utf8",
    );
    const implementationDocFormat = await readFile(
      join(import.meta.dirname, "../shared/implementation-doc-format.md"),
      "utf8",
    );

    expect(storyContract).toContain("TrailStep-created isolated worktree/branch");
    expect(storyContract).toContain("TrailStep creates the reviewed story commit");
    const legacyProductName = "Step" + "Kit";
    expect(storyContract).not.toContain(`${legacyProductName}-created isolated worktree/branch`);
    expect(storyContract).not.toContain(`${legacyProductName} creates the reviewed story commit`);
    expect(implementationDocFormat).toContain("<!-- trailstep-story-boundary -->");
  });
});
