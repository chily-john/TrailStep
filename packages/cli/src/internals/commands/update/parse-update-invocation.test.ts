import { describe, expect, it } from "vitest";

import { CliUsageError } from "../../command.types.js";
import { resolveCommand } from "../../command-registry.js";
import { parseUpdateInvocation } from "./parse-update-invocation.js";

describe("parseUpdateInvocation", () => {
  it("parses bare update as StepKit self-update scope", () => {
    expect(parseUpdateInvocation(["update"])).toEqual({
      scope: { kind: "self" },
      force: false,
      yes: false,
    });
  });

  it("parses explicit update scopes", () => {
    expect(parseUpdateInvocation(["update", "--all"])).toMatchObject({
      scope: { kind: "all" },
    });
    expect(parseUpdateInvocation(["update", "--workflows"])).toMatchObject({
      scope: { kind: "workflows" },
    });
    expect(parseUpdateInvocation(["update", "--workflow=review"])).toMatchObject({
      scope: { kind: "workflow", name: "review" },
    });
    expect(parseUpdateInvocation(["update", "--workflow", "review"])).toMatchObject({
      scope: { kind: "workflow", name: "review" },
    });
  });

  it("parses force and yes options", () => {
    expect(parseUpdateInvocation(["update", "--force", "--yes"])).toEqual({
      scope: { kind: "self" },
      force: true,
      yes: true,
    });
  });

  it("rejects mutually exclusive scope flags", () => {
    expect(() => parseUpdateInvocation(["update", "--all", "--workflows"])).toThrow(CliUsageError);
    expect(() => parseUpdateInvocation(["update", "--workflows", "--workflow", "review"])).toThrow(
      /Choose only one update scope/,
    );
  });

  it("rejects unknown options with usage text", () => {
    expect(() => parseUpdateInvocation(["update", "--bogus"])).toThrow(/Unknown option: --bogus/);
    expect(() => parseUpdateInvocation(["update", "--bogus"])).toThrow(/stepkit update/);
  });

  it("registers update before workflow fallback", () => {
    expect(resolveCommand(["update"]).name).toBe("update");
  });
});
