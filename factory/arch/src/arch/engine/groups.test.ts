import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGroupIndex, groupForFile } from "./groups.js";
import type { EngineManifest } from "./types.js";

const MANIFEST: EngineManifest = {
  ranks: [
    {
      rank: 0,
      docGroups: ["base"],
      groups: [{ name: "base", root: "src/base", targetGroup: "base" }],
    },
    {
      rank: 1,
      docGroups: ["middle", "top"],
      groups: [
        { name: "middle", root: "src/middle", targetGroup: "middle" },
        { name: "middle-alias", root: "src/middle-alias", targetGroup: "middle" },
        { name: "top", root: "src/nested/top", targetGroup: "top" },
      ],
    },
    {
      rank: 2,
      docGroups: ["deep"],
      groups: [{ name: "deep", root: "src/middle/deep", targetGroup: "deep" }],
    },
  ],
  unrankedGroups: [
    {
      name: "leaf",
      root: "src/leaf",
      targetGroup: "leaf",
      allowedImportRanks: [0],
    },
  ],
};

const PROJECT_ROOT = path.resolve("/arch-engine-groups");

describe("group mapping", () => {
  it("carries rank, target group, and flattened layer index from the manifest", () => {
    const index = buildGroupIndex(MANIFEST, PROJECT_ROOT);

    expect(index.groups.map((group) => group.name)).toEqual([
      "base",
      "middle",
      "middle-alias",
      "top",
      "deep",
      "leaf",
    ]);
    expect(index.groups.map((group) => group.rank)).toEqual([0, 1, 1, 1, 2, null]);
    expect(index.groups.map((group) => group.layerIndex)).toEqual([0, 1, 1, 2, 3, null]);
    expect(index.groups.find((group) => group.name === "middle-alias")?.targetGroup).toBe("middle");
  });

  it("assigns a file to the deepest declared root that contains it", () => {
    const index = buildGroupIndex(MANIFEST, PROJECT_ROOT);
    const absolute = (relative: string): string => path.resolve(PROJECT_ROOT, relative);

    expect(groupForFile(index, absolute("src/base/base.ts"))?.name).toBe("base");
    expect(groupForFile(index, absolute("src/middle/any/depth/file.ts"))?.name).toBe("middle");
    expect(groupForFile(index, absolute("src/middle/deep/file.ts"))?.name).toBe("deep");
    expect(groupForFile(index, absolute("src/nested/top/file.ts"))?.name).toBe("top");
    expect(groupForFile(index, absolute("src/leaf/file.ts"))?.name).toBe("leaf");
  });

  it("leaves the package root and lookalike sibling folders ungrouped", () => {
    const index = buildGroupIndex(MANIFEST, PROJECT_ROOT);
    const absolute = (relative: string): string => path.resolve(PROJECT_ROOT, relative);

    expect(groupForFile(index, absolute("src/index.ts"))).toBeNull();
    expect(groupForFile(index, absolute("src/nested/other.ts"))).toBeNull();
    // `src/middleware` is a sibling, not a child of `src/middle`: the match is
    // segment-aware, not a string prefix.
    expect(groupForFile(index, absolute("src/middleware/file.ts"))).toBeNull();
  });
});
