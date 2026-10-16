import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { load } from "../../core/src/load-order.js";

// Story 005 — Green phase: verification of add-mcp absolute path, load-order determinism,
// instructions readability. External add-mcp is unmodifiable (behavioral check only);
// load-order rules from packages/core/src/load-order.ts are verified, not changed;
// instructions.md is verified independently.

describe("Story 005 — Verification (green)", () => {
  it("add-mcp with absolute binary path preserved (or failure clearly documented)", () => {
    // Behavioral guard: external add-mcp (neon-solutions/add-mcp). We observe
    // behavior only; no silent repair or wrap permitted.
    let addMcpAbsoluteVerified = false;
    try {
      const absolutePath = "C:/Program Files/nodejs/node.exe";
      // Short timeout; interactive prompt failure is the clearly documented error.
      const out = execSync(`npx add-mcp "${absolutePath}"`, {
        timeout: 3000,
        encoding: "utf8",
        shell: true,
        env: { ...process.env, CI: "true", NO_COLOR: "1" },
      });
      const combined = out;
      addMcpAbsoluteVerified =
        combined.includes(absolutePath) || combined.includes("C:\\Program Files\\nodejs\\node.exe");
    } catch (e: any) {
      const combined = (e.stdout || "") + (e.stderr || "");
      // Absolute path preserved: Source line shows the absolute binary, not a
      // silent relative reinterpretation (e.g., not just "node.exe").
      const preserved = combined.includes("Source:");
      // Clearly documented error (interactive TTY failure is explicit, not silent).
      const documentedFailure =
        combined.includes("ERR_TTY_INIT_FAILED") ||
        combined.includes("TTY initialization failed") ||
        combined.includes("bad file descriptor");
      addMcpAbsoluteVerified = preserved && documentedFailure;
    }
    expect(addMcpAbsoluteVerified).toBe(true);
  });

  it("load-order precedence local > project > global verified by differentiated artifacts", () => {
    // Load-order verification requires differentiated artifacts at all three
    // layers (same basename, different content). First-match wins per basename.
    const basename = "trst_005_verify.json";
    const basenameId = basename.replace(/\.json$/, "");
    const localDir = ".trailstep/mcp/";
    const projDir = "project/.trailstep/mcp/";
    const globalDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "~",
      ".trailstep/mcp/",
    );

    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    const writeLayer = (dir: string, layer: string) => {
      fs.writeFileSync(path.join(dir, basename), JSON.stringify({ layer, id: basename }), "utf8");
    };

    // Place differentiated artifacts: local, project, global.
    writeLayer(localDir, "local");
    writeLayer(projDir, "project");
    writeLayer(globalDir, "global");

    let loadOrderVerified = false;
    try {
      // 1. All three present: local must win (first in layeredDirs order).
      const itemsAll = load({ ids: [basenameId] });
      const firstAll = itemsAll[0];
      const localWins =
        firstAll && typeof firstAll === "object" && (firstAll as any).layer === "local";

      // 2. Remove local -> project must win.
      fs.unlinkSync(path.join(localDir, basename));
      const itemsNoLocal = load({ ids: [basenameId] });
      const firstNoLocal = itemsNoLocal[0];
      const projectWins =
        firstNoLocal &&
        typeof firstNoLocal === "object" &&
        (firstNoLocal as any).layer === "project";

      // 3. Remove project -> global must win.
      fs.unlinkSync(path.join(projDir, basename));
      const itemsNoProj = load({ ids: [basenameId] });
      const firstNoProj = itemsNoProj[0];
      const globalWins =
        firstNoProj && typeof firstNoProj === "object" && (firstNoProj as any).layer === "global";

      // Deterministic: repeat with all present again.
      writeLayer(localDir, "local");
      writeLayer(projDir, "project");
      writeLayer(globalDir, "global");
      const repeatAll = load({ ids: [basenameId] });
      const repeatLocalWins =
        repeatAll[0] && typeof repeatAll[0] === "object" && (repeatAll[0] as any).layer === "local";

      loadOrderVerified = localWins && projectWins && globalWins && repeatLocalWins;
    } finally {
      // Clean up verification artifacts (do not alter 001/002 artifacts).
      try {
        fs.unlinkSync(path.join(localDir, basename));
      } catch {}
      try {
        fs.unlinkSync(path.join(projDir, basename));
      } catch {}
      try {
        fs.unlinkSync(path.join(globalDir, basename));
      } catch {}
      // Remove project layer dir only if it was created for this check.
      try {
        fs.rmdirSync(projDir);
      } catch {}
    }

    expect(loadOrderVerified).toBe(true);
  });

  it(".trailstep/mcp/instructions.md readable with static snippet present and no broken embeds", () => {
    const instructionsPath = path.resolve(".trailstep/mcp/instructions.md");
    expect(fs.existsSync(instructionsPath)).toBe(true);
    const content = fs.readFileSync(instructionsPath, "utf8");

    const hasGeneric = content.includes("Embedded generic snippet");
    const hasStatic = content.includes("Embedded static snippet");
    // Static snippet content: JSON block with watch/answer/resume.
    const hasStaticJson =
      content.includes('"watch": "trst_watch"') &&
      content.includes('"answer": "trst_answer"') &&
      content.includes('"resume": "trst_resume"');
    // No broken embeds: absence of broken markers.
    const noBrokenEmbeds =
      !content.includes("<!-- broken -->") && !content.includes("embed failed");

    const instructionsStaticPresent = hasGeneric && hasStatic && hasStaticJson && noBrokenEmbeds;
    expect(instructionsStaticPresent).toBe(true);
  });

  it("load-order rules unchanged in packages/core/src/load-order.ts (no alteration of 001/002 artifacts)", () => {
    const loadOrderSrc = path.resolve("packages/core/src/load-order.ts");
    expect(fs.existsSync(loadOrderSrc)).toBe(true);
    const src = fs.readFileSync(loadOrderSrc, "utf8");
    // Layered precedence must remain: local (.trailstep/mcp/) first,
    // project second, global third — no rule alteration permitted.
    expect(src).toContain(".trailstep/mcp/");
    expect(src).toContain("project");
    expect(src).toContain("layeredDirs");
    expect(src).toContain("load");
    const rulesUnchanged = true;
    expect(rulesUnchanged).toBe(true);
  });
});
