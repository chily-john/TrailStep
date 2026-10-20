import type { Event } from "@trailstep/core";

/**
 * Assert that `expected` appears as an ordered subsequence of `events`
 * (extra events between expectations are allowed). On mismatch, throws with
 * the failing expected index, the expected type, and the actual types.
 */
export function expectEventSequence(
  events: readonly { readonly type: Event["type"] }[],
  expected: readonly Event["type"][],
): void {
  let scanFrom = 0;
  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const wanted = expected[expectedIndex];
    const foundIndex = events.findIndex(
      (event, index) => index >= scanFrom && event.type === wanted,
    );
    if (foundIndex === -1) {
      const matched = expected.slice(0, expectedIndex);
      const actualTypes = events.map((event) => event.type);
      throw new Error(
        [
          `Event sequence mismatch at expected index ${expectedIndex} of ${expected.length}: expected "${wanted}".`,
          `Matched prefix: ${JSON.stringify(matched)}.`,
          `Remaining actual types: ${JSON.stringify(actualTypes.slice(scanFrom))}.`,
          `All actual types: ${JSON.stringify(actualTypes)}.`,
        ].join(" "),
      );
    }
    scanFrom = foundIndex + 1;
  }
}
