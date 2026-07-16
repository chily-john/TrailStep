import { describe, expect, it } from "vitest";

import { dashboardPlaceholderMessage, dashboardPlaceholderTitle } from "./placeholder";

describe("dashboard local event viewer copy", () => {
  it("dashboard copy describes live local StepKit events rather than placeholder telemetry", () => {
    expect(dashboardPlaceholderTitle).toBe("StepKit Local Runs");
    expect(dashboardPlaceholderMessage).toContain("live local StepKit events");
    expect(dashboardPlaceholderMessage).not.toContain(
      "does not display real workflow telemetry yet",
    );
  });
});
