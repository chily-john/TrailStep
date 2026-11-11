import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import { readRunEventsBounded, scanRunEventsBounded } from "./bounded-readers.js";

async function tempEventsFile(lines: readonly string[]): Promise<{
  readonly eventsFile: string;
  readonly text: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "trailstep-bounded-reader-"));
  const eventsFile = join(dir, "events.jsonl");
  const text = lines.join("\n");
  await writeFile(eventsFile, `${text}\n`, "utf8");
  return { eventsFile, text };
}

function event(index: number, payload: Record<string, unknown> = {}): Event {
  return {
    id: `evt_${index}`,
    runId: "run-1",
    workflowId: "workflow-1",
    type: "step.progress",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload,
  };
}

describe("bounded event readers", () => {
  it("stats first and stops at the byte budget instead of reading the whole trail", async () => {
    const lines = Array.from({ length: 100 }, (_, index) =>
      JSON.stringify(event(index, { body: "x".repeat(1024) })),
    );
    const { eventsFile, text } = await tempEventsFile(lines);

    const scan = await scanRunEventsBounded({
      eventsFile,
      maxBytes: 2048,
      maxLineBytes: 4096,
      maxEvents: 1000,
    });

    expect(scan.fileSize).toBe(Buffer.byteLength(`${text}\n`, "utf8"));
    expect(scan.fileSize).toBeGreaterThan(2048);
    expect(scan.bytesRead).toBe(2048);
    expect(scan.complete).toBe(false);
    expect(scan.coverage).toBe("partial");
    expect(scan.nextOffset).toBeLessThan(scan.fileSize);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");
  });

  it("streams a line that spans multiple underlying chunks", async () => {
    const large = "y".repeat(100 * 1024);
    const { eventsFile, text } = await tempEventsFile([
      JSON.stringify(event(1, { body: large })),
      JSON.stringify(event(2)),
    ]);

    const scan = await readRunEventsBounded({
      eventsFile,
      maxBytes: Buffer.byteLength(`${text}\n`, "utf8") + 1,
      maxLineBytes: 200 * 1024,
      maxEvents: 100,
    });

    expect(scan.complete).toBe(true);
    expect(scan.coverage).toBe("complete");
    expect(scan.events.map((entry) => entry.id)).toEqual(["evt_1", "evt_2"]);
  });

  it("retains only matching events so listing memory stays flat", async () => {
    const lines = Array.from({ length: 1000 }, (_, index) => JSON.stringify(event(index)));
    const { eventsFile, text } = await tempEventsFile(lines);

    const scan = await scanRunEventsBounded({
      eventsFile,
      maxBytes: Buffer.byteLength(`${text}\n`, "utf8"),
      maxLineBytes: 4096,
      maxEvents: 2000,
      retain: (entry) => entry.id === "evt_999",
    });

    expect(scan.complete).toBe(true);
    expect(scan.scannedEvents).toBe(1000);
    expect(scan.events.map((entry) => entry.id)).toEqual(["evt_999"]);
    expect(scan.lastEvent?.id).toBe("evt_999");
  });

  it("reports malformed and non-event lines without throwing", async () => {
    const { eventsFile } = await tempEventsFile([
      JSON.stringify(event(1)),
      "{not-json}",
      JSON.stringify({ hello: "world" }),
      JSON.stringify(event(2)),
    ]);

    const scan = await readRunEventsBounded({
      eventsFile,
      maxBytes: 64 * 1024,
      maxLineBytes: 4096,
      maxEvents: 100,
    });

    expect(scan.events.map((entry) => entry.id)).toEqual(["evt_1", "evt_2"]);
    expect(scan.malformedLines).toBe(2);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain("malformed-record");
    expect(scan.coverage).toBe("partial");
  });

  it("reports a typed budget diagnostic for an aborted signal and an exhausted deadline", async () => {
    const { eventsFile } = await tempEventsFile([JSON.stringify(event(1))]);

    const aborted = await scanRunEventsBounded({
      eventsFile,
      maxBytes: 1024,
      maxLineBytes: 1024,
      maxEvents: 10,
      signal: AbortSignal.abort(),
    });
    expect(aborted.complete).toBe(false);
    expect(aborted.coverage).toBe("partial");
    expect(aborted.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["budget-exceeded"]);

    const expired = await scanRunEventsBounded({
      eventsFile,
      maxBytes: 1024,
      maxLineBytes: 1024,
      maxEvents: 10,
      deadlineMs: 0,
    });
    expect(expired.complete).toBe(false);
    expect(expired.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");
  });

  it("aborts a single line that exceeds the line budget instead of buffering it", async () => {
    const { eventsFile } = await tempEventsFile([
      JSON.stringify(event(1, { body: "z".repeat(20 * 1024) })),
    ]);

    const scan = await scanRunEventsBounded({
      eventsFile,
      maxBytes: 64 * 1024,
      maxLineBytes: 4 * 1024,
      maxEvents: 10,
    });

    expect(scan.complete).toBe(false);
    expect(scan.scannedEvents).toBe(0);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");
  });
});
