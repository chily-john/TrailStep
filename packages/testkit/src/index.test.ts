import { describe, expect, it } from "vitest";

import { testkitScaffoldMarker } from "./index.js";

describe("@stepkit/testkit scaffold", () => {
  it("exports only a neutral temporary scaffold marker", () => {
    expect(testkitScaffoldMarker).toBe("@stepkit/testkit temporary scaffold");
  });
});
