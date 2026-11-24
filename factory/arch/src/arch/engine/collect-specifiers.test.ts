import { describe, expect, it } from "vitest";
import { collectSpecifiers } from "./collect-specifiers.js";

function kinds(source: string): readonly (readonly [string, string])[] {
  return collectSpecifiers("fixture.ts", source).map(({ specifier, kind }) => [specifier, kind]);
}

describe("specifier collection", () => {
  it("collects static imports, re-exports, side-effect imports, and literal dynamic imports", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { B } from "./b.js";',
      'import { type C, d } from "./c.js";',
      'import { type E, type F } from "./e.js";',
      'import Default, { type G } from "./g.js";',
      'import * as ns from "./ns.js";',
      'import "./side-effect.js";',
      'export * from "./star.js";',
      'export type { H } from "./h.js";',
      'export { type I, type J } from "./ij.js";',
      'export { type K, l } from "./kl.js";',
      'export type * from "./type-star.js";',
      'export * as namespace from "./namespace.js";',
      'const lazy = () => import("./lazy.js");',
      'const withAttrs = () => import("./attrs.js", { with: {} });',
      'const withTypeAttrs = () => import("./type-attrs.js", { with: { type: "json" } });',
      'type ImportedType = import("./import-type.js").Thing;',
      'type TypeofType = typeof import("./typeof-type.js");',
      "const notLiteral = (name: string) => import(name);",
    ].join("\n");

    expect(kinds(source)).toEqual([
      ["./a.js", "value"],
      ["./b.js", "type"],
      ["./c.js", "value"],
      ["./e.js", "type"],
      ["./g.js", "value"],
      ["./ns.js", "value"],
      ["./side-effect.js", "value"],
      ["./star.js", "value"],
      ["./h.js", "type"],
      ["./ij.js", "type"],
      ["./kl.js", "value"],
      ["./type-star.js", "type"],
      ["./namespace.js", "value"],
      ["./lazy.js", "value"],
      ["./attrs.js", "value"],
      ["./type-attrs.js", "value"],
      ["./import-type.js", "type"],
      ["./typeof-type.js", "type"],
    ]);
  });

  it("classifies a literal dynamic import with attributes as a value edge", () => {
    expect(kinds('const load = () => import("./x.js", { with: {} });')).toEqual([
      ["./x.js", "value"],
    ]);
  });

  it('classifies import("…").T and typeof import("…") as type edges', () => {
    expect(
      kinds(
        [
          'export type A = import("./a.js").A;',
          'export type B = typeof import("./b.js");',
          'type Dynamic = typeof import("./c.js", { with: {} });',
        ].join("\n"),
      ),
    ).toEqual([
      ["./a.js", "type"],
      ["./b.js", "type"],
      ["./c.js", "type"],
    ]);
  });

  it("does not collect a non-literal import type argument", () => {
    // Joined so this test file has no literal `${` for Biome's
    // noTemplateCurlyInString rule to flag; the fixture still parses as a
    // template literal type argument.
    const dynamicType = ["export type T = import(`./", "$", "{name}.js`).T;"].join("");

    expect(kinds(dynamicType)).toEqual([]);
  });

  it("reports a 1-based line and column for each specifier", () => {
    const source = ['import { a } from "./a.js";', "", '  export * from "./b.js";'].join("\n");

    expect(
      collectSpecifiers("fixture.ts", source).map(({ line, column }) => ({ line, column })),
    ).toEqual([
      { line: 1, column: 1 },
      { line: 3, column: 3 },
    ]);
  });

  it("classifies empty binding lists as value imports", () => {
    expect(
      kinds(['import {} from "./empty.js";', 'export {} from "./empty-export.js";'].join("\n")),
    ).toEqual([
      ["./empty.js", "value"],
      ["./empty-export.js", "value"],
    ]);
  });
});
