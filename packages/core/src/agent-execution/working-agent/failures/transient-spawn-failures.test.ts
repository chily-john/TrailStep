import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import {
  isTransientSpawnErrorCode,
  isTransientSpawnExitCode,
  isTransientWorkingAgentFailure,
} from "./transient-spawn-failures.js";

describe("isTransientSpawnExitCode", () => {
  it("treats NTSTATUS process-level deaths as transient", () => {
    expect(isTransientSpawnExitCode(3221225794)).toBe(true); // 0xC0000142 STATUS_DLL_INIT_FAILED
    expect(isTransientSpawnExitCode(0xc000_0005)).toBe(true); // access violation crash
    expect(isTransientSpawnExitCode(0xc000_0017)).toBe(true); // STATUS_NO_MEMORY
  });

  it("treats normal exit codes as non-transient", () => {
    expect(isTransientSpawnExitCode(0)).toBe(false);
    expect(isTransientSpawnExitCode(1)).toBe(false);
    expect(isTransientSpawnExitCode(7)).toBe(false);
    expect(isTransientSpawnExitCode(-1)).toBe(false);
  });
});

describe("isTransientSpawnErrorCode", () => {
  it("matches resource-exhausted spawn errors only", () => {
    expect(isTransientSpawnErrorCode("EAGAIN")).toBe(true);
    expect(isTransientSpawnErrorCode("EMFILE")).toBe(true);
    expect(isTransientSpawnErrorCode("spawn EMFILE")).toBe(true);
    expect(isTransientSpawnErrorCode("ENOENT")).toBe(false);
    expect(isTransientSpawnErrorCode(undefined)).toBe(false);
  });
});

describe("isTransientWorkingAgentFailure", () => {
  it("classifies provider failures by exit code", () => {
    const transient = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "exited with code 3221225794",
      details: { phase: "format", exitCode: 3221225794 },
    });
    const real = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "exited with code 7",
      details: { phase: "work", exitCode: 7 },
    });
    expect(isTransientWorkingAgentFailure(transient)).toBe(true);
    expect(isTransientWorkingAgentFailure(real)).toBe(false);
  });

  it("classifies spawn errors by errno", () => {
    const transient = new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "could not start",
      details: { spawnErrorCode: "EAGAIN" },
    });
    const real = new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "could not start",
      details: { spawnErrorCode: "ENOENT" },
    });
    expect(isTransientWorkingAgentFailure(transient)).toBe(true);
    expect(isTransientWorkingAgentFailure(real)).toBe(false);
  });

  it("rejects plain errors and unrelated failures", () => {
    expect(isTransientWorkingAgentFailure(new Error("boom"))).toBe(false);
    expect(
      isTransientWorkingAgentFailure(
        new TrailStepFailureError({ code: "validation_failed", message: "bad output" }),
      ),
    ).toBe(false);
  });
});
