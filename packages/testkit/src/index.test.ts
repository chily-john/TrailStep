import { describe, expect, it } from "vitest";

import { testkitPackageMarker } from "./index.js";

describe("@stepkit/testkit exports", () => {
  it("exports a package marker", () => {
    expect(testkitPackageMarker).toBe("@stepkit/testkit");
  });
});
