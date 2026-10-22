import { describe, expect, it, vi } from "vitest";

vi.mock("@trailstep/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trailstep/core")>();

  return {
    ...actual,
    readRunEvents: async (): Promise<never> => {
      // A failure that crossed a serialization boundary: the code survives,
      // the message does not.
      throw { failure: { code: "resume_target_not_found" } };
    },
  };
});

const { readDashboardRunEvents } = await import("./events");

describe("dashboard failure inspection", () => {
  it("maps a failure-like error without a message to an empty event list", async () => {
    await expect(readDashboardRunEvents("any-run-dir")).resolves.toEqual([]);
  });
});
