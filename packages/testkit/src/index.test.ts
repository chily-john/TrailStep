import { describe, expect, it } from "vitest";

import { testkitPackageMarker } from "./index.js";

describe("@trailstep/testkit exports", () => {
  it("exports a package marker", () => {
    expect(testkitPackageMarker).toBe("@trailstep/testkit");
  });
});
