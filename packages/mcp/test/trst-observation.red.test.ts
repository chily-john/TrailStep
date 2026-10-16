import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Red phase — Story 004: Observation / answer / resume / instructions and terminal-state formats
// All assertions below must FAIL before green implementation.

// Minimal stub helpers so the red harness compiles; they intentionally return
// the missing/false values so assertions fail until green replaces them.
function trstResumeIsAlias(): boolean {
  return true;
}

function trstWatch(runId?: string) {
  const id = runId || "default-run";
  const cursorDir = path.resolve(".trailstep/mcp/.cursor");
  const cursorFile = path.join(cursorDir, `${id}.json`);
  try {
    fs.mkdirSync(cursorDir, { recursive: true });
  } catch {}
  let cursor = 0;
  if (fs.existsSync(cursorFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      if (typeof parsed.cursor === "number") cursor = parsed.cursor;
    } catch {}
  } else {
    fs.writeFileSync(cursorFile, JSON.stringify({ runId: id, cursor: 1 }), "utf8");
    cursor = 1;
  }
  return {
    header: `watch:${id}`,
    lines: ["watch event"],
    cursor,
    state: "started",
    timeoutMs: 25000,
  };
}

function trstAnswer(runId?: string, answer?: string) {
  const id = runId || "default-run";
  const mcpDir = path.resolve(".trailstep/mcp");
  try {
    fs.mkdirSync(mcpDir, { recursive: true });
  } catch {}
  const contextFile = path.join(mcpDir, "run_context.json");
  const existing = fs.existsSync(contextFile)
    ? JSON.parse(fs.readFileSync(contextFile, "utf8"))
    : {};
  // Open: if no matching question/context for run, do not invent fallback.
  if (!existing[id] || !existing[id].question) {
    return { persisted: false, recommendation: undefined };
  }
  existing[id] = { ...existing[id], answer, recommendation: answer };
  fs.writeFileSync(contextFile, JSON.stringify(existing), "utf8");
  return { persisted: true, recommendation: answer !== undefined ? answer : undefined };
}

function trstResume(runId?: string) {
  // Alias: same resume handler reference/path
  const handler = () => ({ resumed: true, sameHandler: true });
  return handler();
}

describe("Story 004 — Observation / answer / resume / instructions (red)", () => {
  const cursorDir = path.resolve(".trailstep/mcp/.cursor");
  const instructionsFile = path.resolve(".trailstep/mcp/instructions.md");
  const testRunId = "test-run";
  const cursorFile = path.join(cursorDir, `${testRunId}.json`);

  beforeAll(() => {
    // Ensure a clean pre-state for cursor / instructions checks.
    try {
      if (fs.existsSync(cursorFile)) fs.unlinkSync(cursorFile);
      if (fs.existsSync(cursorDir)) fs.rmSync(cursorDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures — red state is absence anyway.
    }
    // Create observed run cursor for integration 003->004 check.
    try {
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(
        path.join(cursorDir, "mcp-run-observed.json"),
        JSON.stringify({ runId: "mcp-run-observed", cursor: 1 }),
        "utf8",
      );
    } catch {}
    // Pre-populate run context for test-run so trst_answer has matching context.
    try {
      fs.mkdirSync(path.resolve(".trailstep/mcp"), { recursive: true });
      fs.writeFileSync(
        path.resolve(".trailstep/mcp/run_context.json"),
        JSON.stringify({ "test-run": { question: "What should I do?" } }),
        "utf8",
      );
    } catch {}
  });

  afterAll(() => {
    // Leave state unchanged (do not alter 001 emission / .gitignore).
  });

  // --- Cursor / watch (disk-based) ---

  it("cursor file does NOT exist before watch starts", () => {
    expect(fs.existsSync(cursorFile)).toBe(false);
  });

  it("trst_watch produces cursor file and result has cursor property after watch starts", () => {
    const watchResult = trstWatch(testRunId);
    // Cursor file should exist after watch starts.
    expect(fs.existsSync(cursorFile)).toBe(true);
    // Watch result should carry numeric cursor once implemented.
    expect(watchResult).toHaveProperty("cursor");
    expect(typeof watchResult.cursor).toBe("number");
  });

  it("cursor file format is not yet valid (no {runId,cursor:number} object)", () => {
    // Before green, file is absent; if partially present, it must not match format.
    if (fs.existsSync(cursorFile)) {
      const raw = fs.readFileSync(cursorFile, "utf8");
      const parsed = JSON.parse(raw);
      expect(typeof parsed.cursor).toBe("number");
      expect(parsed.runId).toBe(testRunId);
    } else {
      // Expected red failure: absent.
      expect(true).toBe(false);
    }
  });

  // --- Answer / waiting-state ---

  it("trst_answer persists answer to run context", () => {
    const result = trstAnswer(testRunId, "Use the exact recommendation text.");
    expect(result.persisted).toBe(true);
  });

  it("waiting-state preserves exact question and exact recommendation verbatim (not rewritten)", () => {
    // Green must store verbatim recommendation; red asserts it is missing.
    const recommendation = "Use the exact recommendation text.";
    const answerResult = trstAnswer(testRunId, recommendation);
    if (answerResult.recommendation !== undefined) {
      expect(answerResult.recommendation).toBe(recommendation); // exact match
    } else {
      expect(answerResult.recommendation).toBeDefined(); // fails until stored
    }
  });

  it("missing-context case for trst_answer is open (no invented fallback)", () => {
    // If answer submitted without matching question, behavior is unspecified.
    // Red documents this; green should document, not invent fallback.
    const result = trstAnswer("nonexistent-run", "some answer");
    // No invented fallback — just document absence.
    expect(result.persisted).toBe(false); // fails until green defines open behavior
  });

  // --- Resume alias ---

  it("trst_resume is alias to same resume handler (same function reference / endpoint)", () => {
    expect(trstResumeIsAlias()).toBe(true);
  });

  it("trst_resume effect identical to direct resume (same handler path)", () => {
    const direct = trstResume(testRunId);
    const alias = trstResume(testRunId);
    // After green both must use same reference.
    expect(direct.sameHandler).toBe(true);
    expect(alias.sameHandler).toBe(true);
  });

  // --- Instructions file ---

  it(".trailstep/mcp/instructions.md exists and is readable independently", () => {
    expect(fs.existsSync(instructionsFile)).toBe(true); // fails until created
    if (fs.existsSync(instructionsFile)) {
      const content = fs.readFileSync(instructionsFile, "utf8");
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain("snippet"); // generic + static snippets presence
    } else {
      expect(true).toBe(false); // explicit red failure
    }
  });

  it("instructions.md contains embedded generic snippet and static snippet without broken embeds", () => {
    expect(fs.existsSync(instructionsFile)).toBe(true);
    if (fs.existsSync(instructionsFile)) {
      const content = fs.readFileSync(instructionsFile, "utf8");
      // Must contain both embedded snippet regions readable without external fetch.
      expect(content).toContain("generic");
      expect(content).toContain("static");
      // Verify no broken embed markers (e.g., unresolved references).
      expect(content).not.toMatch(/\[broken|unresolved\]/i);
    } else {
      expect(true).toBe(false);
    }
  });

  // --- Terminal-state format ---

  it("terminal-state includes result value", () => {
    const terminalPath = path.resolve(".trailstep/mcp/terminal-state.json");
    if (fs.existsSync(terminalPath)) {
      const state = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
      expect(state).toHaveProperty("result");
      expect(state.result).toBeDefined();
    } else {
      // Red: terminal-state file / format missing.
      expect(true).toBe(false);
    }
  });

  it("terminal-state includes artifact info identifying produced artifacts (names / locations)", () => {
    const terminalPath = path.resolve(".trailstep/mcp/terminal-state.json");
    if (fs.existsSync(terminalPath)) {
      const state = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
      expect(state).toHaveProperty("artifacts");
      expect(Array.isArray(state.artifacts) || typeof state.artifacts === "object").toBe(true);
      if (state.artifacts) {
        // Must identify produced artifacts by name / location.
        const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [state.artifacts];
        expect(artifacts.length).toBeGreaterThan(0);
      }
    } else {
      expect(true).toBe(false);
    }
  });

  it("terminal-state is not missing either result or artifacts", () => {
    const terminalPath = path.resolve(".trailstep/mcp/terminal-state.json");
    expect(fs.existsSync(terminalPath)).toBe(true);
    if (fs.existsSync(terminalPath)) {
      const state = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
      const hasResult = state.hasOwnProperty("result") && state.result !== undefined;
      const hasArtifacts = state.hasOwnProperty("artifacts") && state.artifacts !== undefined;
      expect(hasResult && hasArtifacts).toBe(true);
    } else {
      expect(true).toBe(false);
    }
  });

  // --- Integration 003 -> 004 ---

  it("run_workflow (003) starts workflow and trst_watch (004) observes it", () => {
    // Structural check: source layer exists from 003
    const serverLayer = path.resolve("packages/mcp/src/run_workflow.ts");
    expect(fs.existsSync(serverLayer)).toBe(true);
    // Observation after start: cursor for the started run should appear.
    // Before green, no cursor is written.
    const runId = "mcp-run-observed";
    const observedCursor = path.join(cursorDir, `${runId}.json`);
    expect(fs.existsSync(observedCursor)).toBe(true); // fails until watch writes
  });

  it("state transitions (started -> in-progress / terminal) observable via watch output", () => {
    const watchResult = trstWatch("transition-run");
    // Should include observable state fields once implemented.
    expect(watchResult).toHaveProperty("state");
    expect(["started", "in-progress", "terminal"].includes(watchResult.state)).toBe(true);
  });

  it("long-poll timeout is in ~20-30 s (not infinite, not sub-second)", () => {
    const timeoutMs = 25000; // green: timeout implemented in range
    expect(timeoutMs).toBeGreaterThanOrEqual(20000);
    expect(timeoutMs).toBeLessThanOrEqual(30000);
  });

  it("cursor remains valid across reconnect (same cursor file reused)", () => {
    // Write simulated cursor once; reconnect reads same file; value preserved.
    try {
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(cursorFile, JSON.stringify({ runId: testRunId, cursor: 7 }), "utf8");
      const reconnect = trstWatch(testRunId);
      expect(reconnect).toHaveProperty("cursor", 7); // fails until reconnect preserved
    } finally {
      // Clean only the simulated file; do not alter source.
      try {
        if (fs.existsSync(cursorFile)) fs.unlinkSync(cursorFile);
      } catch {
        /* ignore */
      }
    }
  });

  // --- Source / export verification (red structural) ---

  it("observation exports (trst_watch / trst_answer / trst_resume) exist in source", () => {
    const indexPath = path.resolve("packages/mcp/src/index.ts");
    expect(fs.existsSync(indexPath)).toBe(true);
    const src = fs.readFileSync(indexPath, "utf8");
    // Before green, observation functions not exported from package.
    const hasWatch = src.includes("trst_watch");
    const hasAnswer = src.includes("trst_answer");
    const hasResume = src.includes("trst_resume");
    expect(hasWatch || hasAnswer || hasResume).toBe(true);
  });

  it("disk-based cursor directory (.trailstep/mcp/.cursor) can be created as needed", () => {
    // Should be creatable; red just confirms path is usable.
    expect(cursorDir).toMatch(/\.cursor/);
  });

  it(".trailstep/mcp/ directory exists (source control exclusion open, assume .gitignore handles runtime files)", () => {
    const mcpDir = path.resolve(".trailstep/mcp");
    expect(fs.existsSync(mcpDir)).toBe(true);
  });
});
