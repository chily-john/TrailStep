import { describe, expect, it } from "vitest";

import { CliUsageError } from "./command.types.js";
import { parseCommandFlags } from "./flags.js";

describe("parseCommandFlags", () => {
  it('records boolean flags as "true" and value flags by their value', () => {
    const flags = parseCommandFlags(["--force", "--scope", "project"], {
      commandLabel: "trailstep add",
      booleanFlags: ["--force"],
      valueFlags: ["--scope"],
    });

    expect(flags.force).toBe("true");
    expect(flags.scope).toBe("project");
  });

  it("strips the leading dashes from the flag name", () => {
    const flags = parseCommandFlags(["--dry-run", "--force"], {
      commandLabel: "trailstep add",
      booleanFlags: ["--dry-run", "--force"],
    });

    expect(flags["dry-run"]).toBe("true");
    expect(flags.force).toBe("true");
  });

  it("throws a usage error for unknown flags", () => {
    expect(() =>
      parseCommandFlags(["--bogus"], {
        commandLabel: "trailstep add",
        booleanFlags: ["--force"],
        valueFlags: ["--scope"],
      }),
    ).toThrow(new CliUsageError("Unknown option for trailstep add: --bogus"));
  });

  it("throws a usage error for missing values", () => {
    expect(() =>
      parseCommandFlags(["--scope"], {
        commandLabel: "trailstep remove",
        valueFlags: ["--scope"],
      }),
    ).toThrow(new CliUsageError("Missing value for --scope."));
  });

  it("rejects empty values unless empty values are allowed", () => {
    expect(() =>
      parseCommandFlags(["--scope", ""], {
        commandLabel: "trailstep remove",
        valueFlags: ["--scope"],
      }),
    ).toThrow(new CliUsageError("Missing value for --scope."));

    const flags = parseCommandFlags(["--scope", ""], {
      commandLabel: "trailstep providers",
      valueFlags: ["--scope"],
      allowEmptyValue: true,
    });

    expect(flags.scope).toBe("");
  });

  it("ignores unknown flags when the caller asks for it", () => {
    const flags = parseCommandFlags(["--bogus", "--project", "dir"], {
      commandLabel: "trailstep mcp",
      valueFlags: ["--project"],
      onUnknownFlag: "ignore",
      onMissingValue: "ignore",
      allowEmptyValue: true,
    });

    expect(flags.project).toBe("dir");
  });

  it("ignores value flags without a value when the caller asks for it", () => {
    const flags = parseCommandFlags(["--project"], {
      commandLabel: "trailstep mcp",
      valueFlags: ["--project"],
      onMissingValue: "ignore",
    });

    expect(flags.project).toBeUndefined();
  });

  it("keeps the last value when a value flag is repeated", () => {
    const flags = parseCommandFlags(["--scope", "local", "--scope", "global"], {
      commandLabel: "trailstep providers",
      valueFlags: ["--scope"],
    });

    expect(flags.scope).toBe("global");
  });
});
