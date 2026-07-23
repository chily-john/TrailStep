import { describe, expect, it } from "vitest";

import {
  addAgentEntryItem,
  editAgentEntryItem,
  removeAgentEntryItem,
  reorderAgentEntryItem,
} from "./agent-entry-items-flow.js";

describe("agent entry item helpers", () => {
  it("adds, removes, reorders, and edits raw items", () => {
    const items: readonly Record<string, unknown>[] = [{ ref: "base" }];

    const added = addAgentEntryItem(items, { provider: "claude" });
    expect(added).toEqual([{ ref: "base" }, { provider: "claude" }]);

    const reordered = reorderAgentEntryItem(added, 1, 0);
    expect(reordered).toEqual([{ provider: "claude" }, { ref: "base" }]);

    const edited = editAgentEntryItem(reordered, 0, { provider: "codex", model: "gpt-5" });
    expect(edited).toEqual([{ provider: "codex", model: "gpt-5" }, { ref: "base" }]);

    expect(removeAgentEntryItem(edited, 1)).toEqual([{ provider: "codex", model: "gpt-5" }]);
  });
});
