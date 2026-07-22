import { describe, expect, it } from "vitest";

import { usageText } from "./command.types.js";

describe("usageText", () => {
  it("documents workflow skill distribution flags, init scope, and agents management", () => {
    expect(usageText).toContain("--project-skill");
    expect(usageText).toContain("--user-skill");
    expect(usageText).toContain("stepkit init [--scope <project|project-local|user>]");
    expect(usageText).toContain("stepkit agents set <name>");
    expect(usageText).toContain("stepkit agents delete <name>");
    expect(usageText).toContain("stepkit agents rename <old> <new>");
  });
});
