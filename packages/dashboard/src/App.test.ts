import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(fileURLToPath(new URL("./App.svelte", import.meta.url)), "utf8");

describe("dashboard local event viewer copy", () => {
  it("dashboard copy describes live local TrailStep events rather than placeholder telemetry", () => {
    expect(appSource).toContain("TrailStep Local Runs");
    expect(appSource).toContain(
      "Read-only local dashboard for live local TrailStep events from .trailstep/runs.",
    );
    expect(appSource).not.toContain("does not display real workflow telemetry yet");
  });
});
