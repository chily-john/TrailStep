import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph } from "./build-graph.js";
import { buildFixtureGraph } from "./fixture-harness.js";
import { summarizeGraph } from "./summarize.js";
import type { ArchGraph, EngineManifest } from "./types.js";

const MANIFEST: EngineManifest = {
  ranks: [
    {
      rank: 0,
      docGroups: ["lower"],
      groups: [{ name: "lower", root: "src/lower", targetGroup: "lower" }],
    },
    {
      rank: 1,
      docGroups: ["upper"],
      groups: [{ name: "upper", root: "src/upper", targetGroup: "upper" }],
    },
  ],
  unrankedGroups: [],
};

const TWO_GROUP_MANIFEST: EngineManifest = {
  ranks: [
    {
      rank: 0,
      docGroups: ["target"],
      groups: [{ name: "target", root: "src/target", targetGroup: "target" }],
    },
    {
      rank: 1,
      docGroups: ["source"],
      groups: [{ name: "source", root: "src/source", targetGroup: "source" }],
    },
  ],
  unrankedGroups: [],
};

describe("graph building", () => {
  it("classifies value and type edges and maps both endpoints to groups", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/lower/lower.ts": "export const lower = 1;\n",
          "src/upper/upper.ts":
            'import { lower } from "../lower/lower.js";\n' +
            "export type Shape = { lower: number };\n",
          "src/upper/shape.ts": 'export type { Shape } from "./upper.js";\n',
          "src/index.ts": 'export * from "./upper/upper.js";\n',
        },
      },
      MANIFEST,
    );

    try {
      const graph = fixture.graph;

      expect(graph.stats).toEqual({
        files: 4,
        edges: 3,
        valueEdges: 2,
        typeEdges: 1,
        resolutionErrors: 0,
      });
      expect(graph.files.map((file) => [file.path, file.group])).toEqual([
        ["src/index.ts", null],
        ["src/lower/lower.ts", "lower"],
        ["src/upper/shape.ts", "upper"],
        ["src/upper/upper.ts", "upper"],
      ]);
      expect(
        graph.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.fromGroup, edge.toGroup]),
      ).toEqual([
        ["src/index.ts", "src/upper/upper.ts", "value", null, "upper"],
        ["src/upper/shape.ts", "src/upper/upper.ts", "type", "upper", "upper"],
        ["src/upper/upper.ts", "src/lower/lower.ts", "value", "upper", "lower"],
      ]);
      expect(graph.resolutionErrors).toEqual([]);
      const summary = summarizeGraph(graph);
      expect(summary.ungroupedFiles).toBe(1);
      expect(summary.ungroupedValueEdgesOut).toBe(1);
      expect(summary.ungroupedTypeEdgesOut).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("red phase: a .js specifier resolves to its sibling .ts file", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts": 'export * from "../target/target.js";\n',
          "src/target/target.ts": "export const target = 1;\n",
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(1);
      expect(fixture.graph.stats.resolutionErrors).toBe(0);
      expect(fixture.graph.edges[0]).toMatchObject({
        from: "src/source/source.ts",
        to: "src/target/target.ts",
        specifier: "../target/target.js",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("red phase: removing the target file leaves an unresolved diagnostic", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts": 'export * from "../target/target.js";\n',
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(0);
      expect(fixture.graph.stats.resolutionErrors).toBe(1);
      expect(fixture.graph.resolutionErrors[0]).toMatchObject({
        from: "src/source/source.ts",
        specifier: "../target/target.js",
        kind: "value",
        line: 1,
        column: 1,
      });
      expect(fixture.graph.resolutionErrors[0]?.reason).toContain("did not resolve");
    } finally {
      fixture.cleanup();
    }
  });

  it("red phase: a dynamic import with attributes resolves to its sibling .ts file", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts":
            'export const loadLazy = () => import("../target/lazy.js", { with: {} });\n',
          "src/target/lazy.ts": "export const lazy = 1;\n",
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(1);
      expect(fixture.graph.stats.resolutionErrors).toBe(0);
      expect(fixture.graph.edges[0]).toMatchObject({
        from: "src/source/source.ts",
        to: "src/target/lazy.ts",
        specifier: "../target/lazy.js",
        kind: "value",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("red phase: removing the attributed import target yields an unresolved diagnostic", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts":
            'export const loadLazy = () => import("../target/lazy.js", { with: {} });\n',
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(0);
      expect(fixture.graph.stats.resolutionErrors).toBe(1);
      expect(fixture.graph.resolutionErrors[0]).toMatchObject({
        from: "src/source/source.ts",
        specifier: "../target/lazy.js",
        kind: "value",
      });
      expect(fixture.graph.resolutionErrors[0]?.reason).toContain("did not resolve");
    } finally {
      fixture.cleanup();
    }
  });

  it("red phase: an import type argument resolves to its sibling .ts file", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts": 'export type LazyShape = typeof import("../target/lazy.js");\n',
          "src/target/lazy.ts": "export const lazy = 1;\n",
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(1);
      expect(fixture.graph.stats.valueEdges).toBe(0);
      expect(fixture.graph.stats.typeEdges).toBe(1);
      expect(fixture.graph.stats.resolutionErrors).toBe(0);
      expect(fixture.graph.edges[0]).toMatchObject({
        from: "src/source/source.ts",
        to: "src/target/lazy.ts",
        specifier: "../target/lazy.js",
        kind: "type",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("surfaces an unresolved bare package instead of dropping it", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts":
            'import { missing } from "arch-fixture-missing-dependency";\nexport const value = missing;\n',
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(0);
      expect(fixture.graph.resolutionErrors).toHaveLength(1);
      expect(fixture.graph.resolutionErrors[0]?.specifier).toBe("arch-fixture-missing-dependency");
    } finally {
      fixture.cleanup();
    }
  });

  it("never treats Node builtins as edges or resolution errors", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts":
            'import { readFileSync } from "node:fs";\n' +
            'import { join } from "node:path";\n' +
            "export const paths = [readFileSync, join];\n",
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.edges).toBe(0);
      expect(fixture.graph.stats.resolutionErrors).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("excludes test files by default and includes them on request", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts": "export const source = 1;\n",
          "src/source/source.test.ts": 'import { source } from "./source.js";\n',
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      expect(fixture.graph.stats.files).toBe(1);
      expect(fixture.graph.stats.edges).toBe(0);

      const withTests = buildGraph({
        projectRoot: fixture.projectRoot,
        tsconfig: join(fixture.projectRoot, "tsconfig.json"),
        manifest: TWO_GROUP_MANIFEST,
        includeTests: true,
      });

      expect(withTests.stats.files).toBe(2);
      expect(withTests.stats.edges).toBe(1);
      expect(withTests.edges[0]?.to).toBe("src/source/source.ts");
    } finally {
      fixture.cleanup();
    }
  });

  it("produces the same graph object for the fixture path and the real-tree entry point", () => {
    const fixture = buildFixtureGraph(
      {
        files: {
          "src/source/source.ts": 'export type { Target } from "../target/target.js";\n',
          "src/target/target.ts": "export type Target = { value: number };\n",
        },
      },
      TWO_GROUP_MANIFEST,
    );

    try {
      const rebuilt: ArchGraph = buildGraph({
        projectRoot: fixture.projectRoot,
        tsconfig: join(fixture.projectRoot, "tsconfig.json"),
        manifest: TWO_GROUP_MANIFEST,
      });

      expect(JSON.stringify(summarizeGraph(rebuilt))).toBe(
        JSON.stringify(summarizeGraph(fixture.graph)),
      );
      expect(rebuilt.files).toEqual(fixture.graph.files);
      expect(rebuilt.edges).toEqual(fixture.graph.edges);
    } finally {
      fixture.cleanup();
    }
  });
});
