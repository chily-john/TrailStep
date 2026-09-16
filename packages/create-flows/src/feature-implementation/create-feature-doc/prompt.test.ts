import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { createFeatureDocPrompt } from "./prompt.js";

const sectionContent = (document: string, heading: string): string => {
  const marker = `## ${heading}`;
  const start = document.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const contentStart = start + marker.length;
  const nextHeading = document.indexOf("\n## ", contentStart);
  return document.slice(contentStart, nextHeading === -1 ? undefined : nextHeading).trim();
};

describe("createFeatureDocPrompt", () => {
  it("defines scope-preserving feature doc sections for distilling real conversation context", async () => {
    const format = await readFile(
      new URL("../shared/feature-doc-format.md", import.meta.url),
      "utf8",
    );

    expect(format).toContain("## Must-Have Outcome");
    expect(format).toContain("## Explicit Non-Goals");
    expect(format).toContain("## Assumptions and Open Questions");
    expect(format).toContain("## Conversation Context Worth Preserving");
    expect(format).toContain("## Optional / Future Ideas");
    expect(format).toContain("## Structured Scope Facts");
    expect(format).toContain("planning-friendly fact list");
    expect(format).toContain("without turning it into an idealized product specification");
    expect(format).toContain("not acceptance criteria");
  });

  it("discourages inflating a broad request into an oversized product plan", async () => {
    const conversation = await readFile(
      new URL("./fixtures/broad-request-conversation.md", import.meta.url),
      "utf8",
    );
    const prompt = createFeatureDocPrompt({ input: { conversation } });

    expect(prompt).toContain("existing weekly summary table as CSV");
    expect(prompt).toContain("AI insight summaries");
    expect(prompt).toContain("not as permission to finish a product vision");
    expect(prompt).toContain("Do not invent scope");
    expect(prompt).toContain("optional/future ideas are context only");
    expect(prompt).toContain("Use Structured Scope Facts for compact planning metadata");
    expect(prompt).toContain("Do not inflate the request into an idealized product spec");
  });

  it("keeps broad fixture future ideas out of the must-have outcome", async () => {
    const featureDoc = await readFile(
      new URL("./fixtures/broad-request-feature-doc.md", import.meta.url),
      "utf8",
    );

    const mustHave = sectionContent(featureDoc, "Must-Have Outcome");
    const nonGoals = sectionContent(featureDoc, "Explicit Non-Goals");
    const openQuestions = sectionContent(featureDoc, "Assumptions and Open Questions");
    const preservedContext = sectionContent(featureDoc, "Conversation Context Worth Preserving");
    const optionalFuture = sectionContent(featureDoc, "Optional / Future Ideas");
    const structuredScope = sectionContent(featureDoc, "Structured Scope Facts");

    expect(mustHave).toContain("existing weekly summary table as a CSV");
    expect(mustHave).not.toMatch(/AI insight|scheduled|data warehouse|richer charts/i);
    expect(nonGoals).toContain("Do not build a full analytics product");
    expect(openQuestions).toContain("Should CSV include hidden columns?");
    expect(preservedContext).toContain("stay small");
    expect(optionalFuture).toContain("AI insight summaries");
    expect(optionalFuture).toContain("Syncing reports to a data warehouse");
    expect(structuredScope).toContain("Actor: admins");
    expect(structuredScope).toContain("Surface: existing dashboard weekly summary table");
    expect(structuredScope).toContain("Open decision: hidden columns in CSV");
    expect(structuredScope).not.toMatch(/AI insight summaries|richer charts/);
  });
});
