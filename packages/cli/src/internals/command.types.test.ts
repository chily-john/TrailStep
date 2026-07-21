import { describe, expect, it } from "vitest";

import { usageText } from "./command.types.js";

describe("usageText", () => {
  it("documents workflow skill distribution flags for add", () => {
    expect(usageText).toContain("--project-skill");
    expect(usageText).toContain("--user-skill");
  });
});
