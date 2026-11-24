import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFixtureGraph } from "./fixture-harness.js";
import type { EngineManifest } from "./types.js";

const MANIFEST: EngineManifest = {
  ranks: [
    {
      rank: 0,
      docGroups: ["group"],
      groups: [{ name: "group", root: "src/group", targetGroup: "group" }],
    },
  ],
  unrankedGroups: [],
};

describe("fixture harness", () => {
  it("materializes an in-memory tree and removes it on cleanup", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/group/group.ts": "export const value = 1;\n",
          "src/group/nested/other.ts": "export const other = 2;\n",
        },
      },
      MANIFEST,
    );

    expect(fixture.graph.stats.files).toBe(2);
    expect(fixture.graph.files.map((file) => file.group)).toEqual(["group", "group"]);
    expect(existsSync(fixture.projectRoot)).toBe(true);

    fixture.cleanup();
    expect(existsSync(fixture.projectRoot)).toBe(false);
  });

  it("rejects a fixture path that escapes the temporary project root", () => {
    expect(() =>
      buildFixtureGraph({ files: { "../escaped.ts": "export const value = 1;\n" } }, MANIFEST),
    ).toThrow(/escapes the temporary project root/u);
  });

  it("accepts a minimal tsconfig override", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/group/group.ts": "export const value = 1;\n",
          "outside/other.ts": "export const other = 2;\n",
        },
        tsconfig: {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        },
      },
      MANIFEST,
    );

    try {
      expect(fixture.graph.files.map((file) => file.path)).toEqual(["src/group/group.ts"]);
    } finally {
      fixture.cleanup();
    }
  });
});
