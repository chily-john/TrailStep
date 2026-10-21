import { describe, expect, it } from "vitest";

import { resolveCommand } from "./command-registry.js";

describe("resolveCommand", () => {
  it("registers the providers management command", () => {
    expect(resolveCommand(["providers", "list"]).name).toBe("providers");
  });
});
