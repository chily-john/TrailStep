import { describe, expect, it } from "vitest";

import { dashboardPlaceholderMessage, dashboardPlaceholderTitle } from "./placeholder";

describe("dashboard placeholder shell", () => {
  it("identifies itself as a placeholder without real observability data", () => {
    expect(dashboardPlaceholderTitle).toBe("StepKit Dashboard Placeholder");
    expect(dashboardPlaceholderMessage).toContain("does not display real workflow telemetry yet");
  });
});
