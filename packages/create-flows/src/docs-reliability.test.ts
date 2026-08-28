import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  MAX_STORY_REVIEW_ATTEMPTS,
  MAX_STORY_VALIDATION_ATTEMPTS,
  STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD,
} from "./feature-implementation/shared/constants.js";

const createFlowsDiscussion = (readme: string) => {
  const marker = "`@trailstep/create-flows` currently publishes";
  const index = readme.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return readme.slice(index, index + 1_500);
};

describe("create-flows reliability documentation", () => {
  it("documents create-flows retry, resume, reset, and prompt hygiene behavior", async () => {
    const rootReadme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const packageReadme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(createFlowsDiscussion(rootReadme)).toMatch(/durable|retry-aware|resumable/i);
    expect(rootReadme).toMatch(/\.trailstep\/runs|trailstep retry|trailstep continue/i);

    const requiredPackagePatterns = [
      /story router/i,
      /blocked/i,
      /review retry/i,
      /validation retry/i,
      /retry limit|retry cap/i,
      /exhausted/i,
      /\.trailstep\/runs/i,
      /trailstep retry/i,
      /trailstep continue/i,
      /clean story|per-story clean state/i,
      /reviewer prompt/i,
      /diffstat/i,
      /no full diff|without full diff/i,
      /TRAILSTEP_STORY_COMMIT_MODE/,
    ];

    for (const pattern of requiredPackagePatterns) {
      expect(packageReadme).toMatch(pattern);
    }

    expect(packageReadme).toMatch(
      new RegExp(`review retry[^\\n.]*\\b${MAX_STORY_REVIEW_ATTEMPTS}\\b`, "i"),
    );
    expect(packageReadme).toMatch(
      new RegExp(`validation retry[^\\n.]*\\b${MAX_STORY_VALIDATION_ATTEMPTS}\\b`, "i"),
    );
    expect(packageReadme).toMatch(
      new RegExp(`story-doctor[^\\n.]*\\b${STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD}\\b`, "i"),
    );

    const misleadingPackagePatterns = [
      /unbounded retries/i,
      /unlimited retries/i,
      /full-diff reviewer prompt/i,
      /reviewer prompt includes full diff/i,
    ];

    for (const pattern of misleadingPackagePatterns) {
      expect(packageReadme).not.toMatch(pattern);
    }
  });
});
