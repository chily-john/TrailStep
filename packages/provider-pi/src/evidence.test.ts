import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderEvidenceRegistry,
  invokeProviderEvidenceAdapter,
  type ProviderEvidenceCandidateRun,
  type ProviderUsageCounters,
  type ProviderUsageEvidenceRequestV1,
  type RunEvidenceRunRef,
} from "@trailstep/core";
import { afterEach, describe, expect, it } from "vitest";

import { piEvidenceAdapter } from "./evidence.js";
import { createPiSessionReadBudget, readPiSessionFile } from "./pi-session-reader.js";

const FIXTURE_DIR = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
const LIMITS = {
  maxCandidateRuns: 8,
  maxSessions: 16,
  maxFiles: 16,
  maxTotalBytes: 2 * 1024 * 1024,
  maxLineBytes: 64 * 1024,
  maxEntries: 200,
  maxActivities: 64,
  maxResponseBytes: 512 * 1024,
  deadlineMs: 5_000,
} as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-provider-pi-"));
  roots.push(root);
  return root;
}

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIR, name), "utf8");
}

async function writeSession(root: string, relativePath: string, content: string): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

async function writeFixture(
  root: string,
  relativePath: string,
  fixtureName: string,
  transform?: (content: string) => string,
): Promise<string> {
  const content = await fixture(fixtureName);
  return writeSession(root, relativePath, transform === undefined ? content : transform(content));
}

function runRef(runId = "run-1"): RunEvidenceRunRef {
  return {
    project: { kind: "explicit", key: "trailstep" },
    runId,
    startedEventId: "evt-start",
    workflowId: "workflow-a",
    identityQuality: "explicit",
  };
}

function candidate(
  sessionId: string | undefined,
  options: { readonly run?: RunEvidenceRunRef; readonly cwd?: string } = {},
): ProviderEvidenceCandidateRun {
  return {
    run: options.run ?? runRef(),
    spawnEventId: "evt-spawn-1",
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(options.cwd === undefined ? {} : { dispatch: { executionCwd: options.cwd } }),
  };
}

function request(
  providerRoots: readonly string[],
  candidates: readonly ProviderEvidenceCandidateRun[],
  overrides: Partial<ProviderUsageEvidenceRequestV1> = {},
): ProviderUsageEvidenceRequestV1 {
  return {
    kind: "trailstep.provider-evidence-request",
    schemaVersion: 1,
    observedAt: "2026-11-11T10:00:00.000Z",
    provider: { registrationId: "pi", manifestProviderId: "pi" },
    providerRoots,
    candidates,
    limits: { ...LIMITS },
    ...overrides,
  };
}

function setHeaderId(content: string, id: string): string {
  const lines = content.trimEnd().split("\n");
  const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  lines[0] = JSON.stringify({ ...header, id });
  return `${lines.join("\n")}\n`;
}

function transformLine(
  content: string,
  id: string,
  transform: (value: Record<string, unknown>) => void,
): string {
  const lines = content.trimEnd().split("\n");
  const changed = lines.map((line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.id !== id) return line;
    transform(value);
    return JSON.stringify(value);
  });
  return `${changed.join("\n")}\n`;
}

async function expected(name: string): Promise<{ activities: unknown[] }> {
  return JSON.parse(await readFile(join(FIXTURE_DIR, name), "utf8")) as { activities: unknown[] };
}

function sumCounter(
  activities: readonly { counters: ProviderUsageCounters }[],
  field: keyof ProviderUsageCounters,
): number {
  return activities.reduce((total, activity) => total + (activity.counters[field] ?? 0), 0);
}

describe("Pi evidence adapter: formats and extraction", () => {
  it("reads a v3 tree with all five usage sources, every branch, and responseModel", async () => {
    const root = await makeRoot();
    await writeFixture(root, "renamed-not-the-session-id.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));

    expect(result.status).toBe("complete");
    expect(result.coverage).toBe("complete");
    expect(result.adapterRevision).toBe("1");
    expect(result.activities).toHaveLength(8);
    expect(result.activities).toEqual((await expected("expected-v3-full.json")).activities);

    const totalTokens = sumCounter(result.activities, "totalTokens");
    const input = sumCounter(result.activities, "inputTokens");
    const output = sumCounter(result.activities, "outputTokens");
    const cacheRead = sumCounter(result.activities, "cacheReadTokens");
    const cacheWrite = sumCounter(result.activities, "cacheWriteTokens");
    expect(totalTokens).toBe(746);
    expect(input + output + cacheRead + cacheWrite).toBe(746);
    expect(sumCounter(result.activities, "reasoningTokens")).toBe(5);
    expect(sumCounter(result.activities, "cacheWrite1hTokens")).toBe(4);

    const subtotalTokens = sumCounter(result.subtotals, "totalTokens");
    expect(subtotalTokens).toBe(746);
    const subtotalCost = result.subtotals.reduce(
      (total, subtotal) => total + (subtotal.cost?.total ?? 0),
      0,
    );
    expect(subtotalCost).toBeCloseTo(0.0504, 10);

    const assistant = result.activities.find((activity) =>
      activity.activityId.endsWith("/a-1/assistant"),
    );
    expect(assistant?.model).toBe("claude-response");
    expect(assistant?.counters.outputTokens).toBe(50);
    expect(assistant?.counters.reasoningTokens).toBe(5);
    expect(assistant?.counters.cacheWriteTokens).toBe(10);
    expect(assistant?.counters.cacheWrite1hTokens).toBe(4);
    expect(assistant?.cost?.basis).toBe("reported");
  });

  it("reads v2 trees and keeps the v3-only role rename out of usage identity", async () => {
    const root = await makeRoot();
    await writeFixture(root, "v2.jsonl", "session-v2-tree.jsonl");
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-v2")]));

    expect(result.status).toBe("complete");
    expect(result.activities).toHaveLength(2);
    expect(result.activities.every((activity) => activity.sessionFormatVersion === 2)).toBe(true);
    expect(result.activities.map((activity) => activity.kind).sort()).toEqual([
      "assistant",
      "standalone-usage",
    ]);
  });

  it("accepts an arbitrary standalone usage kind instead of rejecting unknown kinds", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl", (content) =>
      transformLine(content, "x-1", (value) => {
        value.kind = "mystery_operation";
      }),
    );
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.status).toBe("complete");
    const standalone = result.activities.find((activity) =>
      activity.activityId.endsWith("/x-1/standalone"),
    );
    expect(standalone?.kind).toBe("standalone-usage");
    expect(standalone?.counters.cacheReadTokens).toBe(500);
  });

  it("returns unsupported for v1 linear sessions and future versions, never zero", async () => {
    const root = await makeRoot();
    await writeFixture(root, "v1.jsonl", "session-v1-linear.jsonl");
    await writeFixture(root, "v4.jsonl", "session-v4-future.jsonl");

    const v1 = await piEvidenceAdapter.readUsage(request([root], [candidate("session-v1")]));
    expect(v1.status).toBe("unsupported");
    expect(v1.activities).toEqual([]);
    expect(v1.subtotals).toEqual([]);
    expect(v1.diagnostics.some((entry) => entry.code === "unsupported-source")).toBe(true);

    const v4 = await piEvidenceAdapter.readUsage(request([root], [candidate("session-v4")]));
    expect(v4.status).toBe("unsupported");
    expect(v4.activities).toEqual([]);
    expect(v4.diagnostics.some((entry) => entry.code === "unsupported-version")).toBe(true);
  });

  it("keeps valid records from torn, malformed and contradictory input and marks coverage partial", async () => {
    const root = await makeRoot();
    await writeFixture(root, "malformed.jsonl", "session-v3-malformed.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-malformed")]),
    );

    expect(result.status).toBe("partial");
    expect(result.coverage).toBe("partial");
    expect(result.activities).toEqual((await expected("expected-v3-malformed.json")).activities);
    expect(result.diagnostics.some((entry) => entry.code === "malformed-record")).toBe(true);
  });

  it("preserves a measured zero as zero and keeps missing cost absent", async () => {
    const root = await makeRoot();
    const content = await fixture("session-v3-full.jsonl");
    const extra = JSON.stringify({
      type: "message",
      id: "a-no-cost",
      parentId: "a-0",
      timestamp: "2026-11-11T10:00:11.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "No cost" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-requested",
        responseId: "resp-no-cost",
        usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
        stopReason: "stop",
        timestamp: 1762855211000,
      },
    });
    await writeSession(root, "full.jsonl", `${content.trimEnd()}\n${extra}\n`);
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));

    expect(result.status).toBe("complete");
    const zero = result.activities.find((activity) =>
      activity.activityId.endsWith("/a-0/assistant"),
    );
    expect(zero?.counters).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
    expect(zero?.cost?.total).toBe(0);

    const noCost = result.activities.find((activity) =>
      activity.activityId.endsWith("/a-no-cost/assistant"),
    );
    expect(noCost?.cost).toBeUndefined();
    expect(noCost?.counters.totalTokens).toBe(4);
  });

  it("merges compatible repeated observations and keeps cost known when one copy omits it", async () => {
    const root = await makeRoot();
    await writeFixture(root, "one.jsonl", "session-v3-full.jsonl");
    await writeFixture(root, "two.jsonl", "session-v3-full.jsonl", (content) =>
      transformLine(content, "a-1", (value) => {
        const message = value.message as Record<string, unknown>;
        const usage = message.usage as Record<string, unknown>;
        delete usage.cost;
      }),
    );
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.status).toBe("complete");
    expect(result.activities).toHaveLength(8);
    const assistant = result.activities.find((activity) =>
      activity.activityId.endsWith("/a-1/assistant"),
    );
    expect(assistant?.cost?.total).toBe(0.033);
    expect(assistant?.counters.inputTokens).toBe(100);
  });

  it("does not let a filename replace a mismatched header id", async () => {
    const root = await makeRoot();
    await writeFixture(root, "session-full.jsonl", "session-v3-full.jsonl", (content) =>
      setHeaderId(content, "other-session"),
    );

    const wrongCandidate = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")]),
    );
    expect(wrongCandidate.status).toBe("partial");
    expect(
      wrongCandidate.activities.every((activity) => activity.attribution === "unattributed"),
    ).toBe(true);
    expect(wrongCandidate.diagnostics.some((entry) => entry.code === "unreadable-source")).toBe(
      true,
    );

    const rightCandidate = await piEvidenceAdapter.readUsage(
      request([root], [candidate("other-session")]),
    );
    expect(rightCandidate.status).toBe("complete");
    expect(rightCandidate.activities.every((activity) => activity.attribution === "run")).toBe(
      true,
    );
  });

  it("keeps equal counters on distinct stable identities distinct", async () => {
    const root = await makeRoot();
    const content = await fixture("session-v3-full.jsonl");
    const line = content
      .trimEnd()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry.id === "a-2");
    if (line === undefined) throw new Error("fixture entry a-2 is missing");
    const clone = JSON.parse(JSON.stringify(line)) as {
      id: string;
      parentId: string;
      timestamp: string;
      message: Record<string, unknown>;
    };
    clone.id = "a-3";
    clone.parentId = "a-2";
    clone.timestamp = "2026-11-11T10:00:12.000Z";
    clone.message.responseId = "resp-3";
    await writeSession(root, "full.jsonl", `${content.trimEnd()}\n${JSON.stringify(clone)}\n`);

    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(
      result.activities.filter((activity) => activity.activityId.endsWith("/a-2/assistant")),
    ).toHaveLength(1);
    expect(
      result.activities.filter((activity) => activity.activityId.endsWith("/a-3/assistant")),
    ).toHaveLength(1);
    expect(result.activities).toHaveLength(9);
  });
});

describe("Pi evidence adapter: discovery and correlation", () => {
  it("matches the header id after move/rename, never the filename", async () => {
    const root = await makeRoot();
    await writeFixture(root, "--wrong-path--/ordinary-name.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.status).toBe("complete");
    expect(result.activities).toHaveLength(8);
  });

  it("discovers a moved session under a second authorized root", async () => {
    const first = await makeRoot();
    const second = await makeRoot();
    await writeFixture(second, "nested/--project--/moved.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([first, second], [candidate("session-full")]),
    );
    expect(result.status).toBe("complete");
    expect(result.activities).toHaveLength(8);
  });

  it("dedupes repeated copies of the same session identity", async () => {
    const root = await makeRoot();
    await writeFixture(root, "one.jsonl", "session-v3-full.jsonl");
    await writeFixture(root, "two.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.status).toBe("complete");
    expect(result.activities).toHaveLength(8);
  });

  it("marks conflicting copies ambiguous instead of latest-wins", async () => {
    const root = await makeRoot();
    await writeFixture(root, "one.jsonl", "session-v3-full.jsonl");
    await writeFixture(root, "two.jsonl", "session-v3-full.jsonl", (content) =>
      transformLine(content, "a-1", (value) => {
        const message = value.message as Record<string, unknown>;
        const usage = message.usage as Record<string, unknown>;
        usage.input = 999;
      }),
    );
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.status).toBe("partial");
    expect(result.diagnostics.some((entry) => entry.code === "ambiguous-identity")).toBe(true);
    expect(
      result.activities.some((activity) => activity.activityId.endsWith("/a-1/assistant")),
    ).toBe(false);
  });

  it("never charges a shared session fully to every run", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request(
        [root],
        [
          candidate("session-full", { run: runRef("run-1") }),
          candidate("session-full", { run: runRef("run-2") }),
        ],
      ),
    );

    expect(result.status).toBe("partial");
    expect(result.activities.every((activity) => activity.attribution === "shared")).toBe(true);
    expect(result.activities.every((activity) => activity.run === undefined)).toBe(true);
    expect(result.subtotals.every((subtotal) => subtotal.attribution === "shared")).toBe(true);
    expect(result.subtotals.every((subtotal) => subtotal.run === undefined)).toBe(true);
  });

  it("counts retries in the same run/session once", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full"), candidate("session-full")]),
    );
    expect(result.status).toBe("complete");
    expect(result.activities).toHaveLength(8);
    expect(result.activities.every((activity) => activity.attribution === "run")).toBe(true);
  });

  it("keeps a candidate without session identity partial and reports unattributed evidence", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate(undefined)]));
    expect(result.status).toBe("partial");
    expect(result.activities).toHaveLength(8);
    expect(result.activities.every((activity) => activity.attribution === "unattributed")).toBe(
      true,
    );
    expect(result.diagnostics.some((entry) => entry.code === "partial-coverage")).toBe(true);
  });

  it("reports a missing candidate session as partial and leaves other sessions unattributed", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("missing-session")]),
    );
    expect(result.status).toBe("partial");
    expect(result.activities).toHaveLength(8);
    expect(result.activities.every((activity) => activity.attribution === "unattributed")).toBe(
      true,
    );
    expect(result.diagnostics.some((entry) => entry.code === "unreadable-source")).toBe(true);
  });

  it("downgrades a dispatch-cwd conflict to ambiguous", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full", { cwd: "/different/project" })]),
    );
    expect(result.status).toBe("partial");
    expect(result.activities.every((activity) => activity.attribution === "ambiguous")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.code === "ambiguous-identity")).toBe(true);
  });

  it("flags cross-session entry copies without request identity as ambiguous", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    await writeFixture(root, "copy.jsonl", "session-v3-full.jsonl", (content) =>
      setHeaderId(content, "session-copy"),
    );
    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.status).toBe("partial");
    expect(
      result.activities.find((activity) => activity.activityId.endsWith("/a-no-response/assistant"))
        ?.attribution,
    ).toBe("ambiguous");
    expect(result.diagnostics.some((entry) => entry.code === "ambiguous-identity")).toBe(true);
  });

  it("rejects a symlink/realpath escape outside the authorized root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFixture(outside, "escaped.jsonl", "session-v3-full.jsonl");
    await symlink(join(outside, "escaped.jsonl"), join(root, "escape.jsonl"));

    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));
    expect(result.activities).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.code === "permission-denied")).toBe(true);
  });
});

describe("Pi evidence adapter: budgets, read-only behavior and the A3a bridge", () => {
  it("returns bounded partial evidence at the entry limit", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")], {
        limits: { ...LIMITS, maxEntries: 4 },
      }),
    );
    expect(result.status).toBe("partial");
    expect(result.activities).toHaveLength(1);
    expect(result.diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);
  });

  it("enforces the per-line byte limit without allocating unbounded lines", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")], {
        limits: { ...LIMITS, maxLineBytes: 350 },
      }),
    );
    expect(result.status).toBe("partial");
    expect(result.activities.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);
  });

  it("returns partial with an empty measured subtotal when usage lines are unreadable", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")], {
        limits: { ...LIMITS, maxLineBytes: 120 },
      }),
    );
    expect(result.status).toBe("partial");
    expect(result.coverage).toBe("partial");
    expect(result.activities).toEqual([]);
    expect(result.subtotals).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);
  });

  it("truncates activities at the configured activity limit and keeps subtotals reconciled", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")], {
        limits: { ...LIMITS, maxActivities: 3 },
      }),
    );
    expect(result.status).toBe("partial");
    expect(result.activities).toHaveLength(3);
    expect(result.diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);
    expect(sumCounter(result.subtotals, "totalTokens")).toBe(
      sumCounter(result.activities, "totalTokens"),
    );
  });

  it("enforces the session limit and the response byte limit", async () => {
    const root = await makeRoot();
    await writeFixture(root, "a.jsonl", "session-v3-full.jsonl");
    await writeFixture(root, "b.jsonl", "session-v2-tree.jsonl");

    const limited = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full"), candidate("session-v2")], {
        limits: { ...LIMITS, maxSessions: 1 },
      }),
    );
    expect(limited.status).toBe("partial");
    expect(limited.diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);

    const oversized = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")], {
        limits: { ...LIMITS, maxResponseBytes: 64 },
      }),
    );
    expect(oversized.status).toBe("unavailable");
    expect(oversized.activities).toEqual([]);
    expect(oversized.diagnostics.some((entry) => entry.code === "oversized-response")).toBe(true);
  });

  it("treats a missing header version as unsupported v1", async () => {
    const root = await makeRoot();
    const content = await fixture("session-v1-linear.jsonl");
    const lines = content.trimEnd().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    delete header.version;
    lines[0] = JSON.stringify(header);
    await writeSession(root, "v1-no-version.jsonl", `${lines.join("\n")}\n`);

    const result = await piEvidenceAdapter.readUsage(request([root], [candidate("session-v1")]));
    expect(result.status).toBe("unsupported");
    expect(result.activities).toEqual([]);
  });

  it("validates partial, unsupported and oversized outcomes through the A3a bridge", async () => {
    const root = await makeRoot();
    await writeFixture(root, "malformed.jsonl", "session-v3-malformed.jsonl");
    const registry = createProviderEvidenceRegistry([
      { registrationId: "pi", manifestProviderId: "pi", adapter: piEvidenceAdapter },
    ]);

    const partial = await invokeProviderEvidenceAdapter({
      registry,
      request: request([root], [candidate("session-malformed")]),
    });
    expect(partial.status).toBe("evidence");
    if (partial.status === "evidence") {
      expect(partial.evidence.status).toBe("partial");
      expect(partial.evidence.diagnostics.length).toBeGreaterThan(0);
    }

    const oversized = await invokeProviderEvidenceAdapter({
      registry,
      request: request([root], [candidate("missing-session")], {
        limits: { ...LIMITS, maxResponseBytes: 64 },
      }),
    });
    expect(oversized.status).toBe("unavailable");

    const v1Root = await makeRoot();
    await writeFixture(v1Root, "v1.jsonl", "session-v1-linear.jsonl");
    const unsupported = await invokeProviderEvidenceAdapter({
      registry,
      request: request([v1Root], [candidate("session-v1")]),
    });
    expect(unsupported.status).toBe("evidence");
    if (unsupported.status === "evidence") {
      expect(unsupported.evidence.status).toBe("unsupported");
      expect(unsupported.evidence.activities).toEqual([]);
    }
  });

  it("stops cooperatively on an already-aborted signal", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const controller = new AbortController();
    controller.abort();
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full")], { signal: controller.signal }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.activities).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.code === "aborted")).toBe(true);
  });

  it("does not create, append, rewrite, move or migrate session files", async () => {
    const root = await makeRoot();
    const sessionPath = await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const beforeContent = await readFile(sessionPath, "utf8");
    const beforeStat = await stat(sessionPath);
    const beforeEntries = (await readdir(root)).sort();

    await piEvidenceAdapter.readUsage(request([root], [candidate("session-full")]));

    const afterContent = await readFile(sessionPath, "utf8");
    const afterStat = await stat(sessionPath);
    const afterEntries = (await readdir(root)).sort();
    expect(afterContent).toBe(beforeContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterEntries).toEqual(beforeEntries);
  });

  it("works through the A3a invocation helper with an injected ephemeral registry", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const registry = createProviderEvidenceRegistry([
      { registrationId: "pi", manifestProviderId: "pi", adapter: piEvidenceAdapter },
    ]);
    const result = await invokeProviderEvidenceAdapter({
      registry,
      request: request([root], [candidate("session-full")]),
    });
    expect(result.status).toBe("evidence");
    if (result.status === "evidence") {
      expect(result.evidence.status).toBe("complete");
      expect(result.evidence.activities).toHaveLength(8);
      expect(JSON.stringify(result.evidence)).not.toContain(root);
    }
  });

  it("reads a session file directly without mutating it for v2/v3/v4", async () => {
    const root = await makeRoot();
    for (const [name, fixtureName, version] of [
      ["v2.jsonl", "session-v2-tree.jsonl", 2],
      ["v3.jsonl", "session-v3-full.jsonl", 3],
      ["v4.jsonl", "session-v4-future.jsonl", 4],
    ] as const) {
      const path = await writeFixture(root, name, fixtureName);
      const before = await readFile(path, "utf8");
      const budget = createPiSessionReadBudget({
        maxTotalBytes: 2 * 1024 * 1024,
        maxLineBytes: 64 * 1024,
        maxEntries: 200,
        deadlineMs: 5_000,
      });
      const read = await readPiSessionFile(path, budget);
      if (version <= 3) {
        expect(read.status).toBe("supported");
        expect(read.header?.formatVersion).toBe(version);
      } else {
        expect(read.status).toBe("unsupported");
        expect(read.formatVersion).toBe(4);
      }
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  it("validates shared, ambiguous and unattributed responses through the A3a bridge", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const registry = createProviderEvidenceRegistry([
      { registrationId: "pi", manifestProviderId: "pi", adapter: piEvidenceAdapter },
    ]);

    const shared = await invokeProviderEvidenceAdapter({
      registry,
      request: request(
        [root],
        [
          candidate("session-full", { run: runRef("run-1") }),
          candidate("session-full", { run: runRef("run-2") }),
        ],
      ),
    });
    expect(shared.status).toBe("evidence");
    if (shared.status === "evidence") {
      expect(shared.evidence.status).toBe("partial");
      expect(
        shared.evidence.activities.every((activity) => activity.attribution === "shared"),
      ).toBe(true);
    }

    const ambiguous = await invokeProviderEvidenceAdapter({
      registry,
      request: request([root], [candidate("session-full", { cwd: "/different/project" })]),
    });
    expect(ambiguous.status).toBe("evidence");
    if (ambiguous.status === "evidence") {
      expect(ambiguous.evidence.status).toBe("partial");
      expect(
        ambiguous.evidence.activities.every((activity) => activity.attribution === "ambiguous"),
      ).toBe(true);
    }

    const unattributed = await invokeProviderEvidenceAdapter({
      registry,
      request: request([root], [candidate(undefined)]),
    });
    expect(unattributed.status).toBe("evidence");
    if (unattributed.status === "evidence") {
      expect(unattributed.evidence.status).toBe("partial");
      expect(
        unattributed.evidence.activities.every(
          (activity) => activity.attribution === "unattributed",
        ),
      ).toBe(true);
    }
  });

  it("does not echo unknown run-reference fields into the response", async () => {
    const root = await makeRoot();
    await writeFixture(root, "full.jsonl", "session-v3-full.jsonl");
    const dirtyRun = {
      ...runRef(),
      secretCanary: "sk-live-do-not-return",
      artifactPath: "/private/transcript.jsonl",
    } as unknown as RunEvidenceRunRef;
    const result = await piEvidenceAdapter.readUsage(
      request([root], [candidate("session-full", { run: dirtyRun })]),
    );
    expect(result.status).toBe("complete");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-live-do-not-return");
    expect(serialized).not.toContain("/private/transcript.jsonl");
  });

  it("rejects an identity mismatch before touching roots", async () => {
    const result = await piEvidenceAdapter.readUsage(
      request(["/does/not/matter"], [candidate("session-full")], {
        provider: { registrationId: "other", manifestProviderId: "other" },
      }),
    );
    expect(result.status).toBe("unsupported");
    expect(result.diagnostics.some((entry) => entry.code === "identity-mismatch")).toBe(true);
  });

  it("treats empty authorized roots as unavailable, never as a measured zero", async () => {
    const result = await piEvidenceAdapter.readUsage(request([], [candidate("session-full")]));
    expect(result.status).toBe("unavailable");
    expect(result.activities).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.code === "missing-provider-roots")).toBe(true);
  });
});
