import { describe, expect, it } from "vitest";

import { CliUsageError } from "../../command.types.js";
import { parseRunArgs } from "./parse-run-args.js";

describe("parseRunArgs", () => {
  it("rejects legacy --resume and points users to retry", () => {
    expect(() => parseRunArgs(["--resume"])).toThrow(CliUsageError);
    expect(() => parseRunArgs(["--resume"])).toThrow(/stepkit retry/i);
  });
});
