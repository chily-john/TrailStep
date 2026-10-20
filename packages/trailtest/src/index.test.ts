import { describe, expect, it } from "vitest";

import { testkitPackageMarker, trailtestPackageMarker } from "./index.js";

describe("@trailstep/trailtest exports", () => {
  it("exports a package marker", () => {
    expect(trailtestPackageMarker).toBe("@trailstep/trailtest");
    expect(testkitPackageMarker).toBe("@trailstep/trailtest");
  });
});
