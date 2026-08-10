import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { list, loadFragments, promptSections, section } from "./prompt-composition.js";

describe("loadFragments", () => {
  it("reads each named file relative to dir and trims trailing whitespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-prompt-fragments-"));
    await writeFile(join(dir, "a.md"), "Fragment A\n", "utf8");
    await writeFile(join(dir, "b.md"), "Fragment B\n\n", "utf8");

    const fragments = loadFragments(dir, { a: "a.md", b: "b.md" });

    expect(fragments).toEqual({ a: "Fragment A", b: "Fragment B" });
  });
});

describe("section", () => {
  it("renders a title and trimmed body as a markdown section", () => {
    expect(section("Task", "Do the thing.\n")).toBe("## Task\n\nDo the thing.");
  });

  it("returns undefined for a falsy body so it can be inlined as a conditional", () => {
    expect(section("Task", undefined)).toBeUndefined();
    expect(section("Task", false)).toBeUndefined();
    expect(section("Task", "")).toBeUndefined();
  });
});

describe("promptSections", () => {
  it("joins parts with a blank line and drops falsy parts", () => {
    expect(promptSections("first", undefined, "second", false, "third")).toBe(
      "first\n\nsecond\n\nthird",
    );
  });

  it("composes with section(...) to build a full prompt", () => {
    expect(promptSections("Intro fragment", section("Task", "Do it."))).toBe(
      "Intro fragment\n\n## Task\n\nDo it.",
    );
  });
});

describe("list", () => {
  it("renders each item as a markdown bullet", () => {
    expect(list(["one", "two"])).toBe("- one\n- two");
  });

  it("renders an empty string for an empty list", () => {
    expect(list([])).toBe("");
  });
});
