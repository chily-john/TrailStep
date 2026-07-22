import { describe, expect, it } from "vitest";

import {
  addAgentEntryItem,
  editAgentEntryItem,
  removeAgentEntryItem,
  reorderAgentEntryItem,
} from "./agent-entry-items-flow.js";

describe("agent entry item helpers", () => {
  it("adds, removes, reorders, and edits raw items while preserving unrelated keys", () => {
    const entry: Record<string, unknown> = { description: "kept", items: [{ ref: "base" }] };

    const added = addAgentEntryItem(entry, { provider: "claude" });
    expect(added).toEqual({
      description: "kept",
      items: [{ ref: "base" }, { provider: "claude" }],
    });

    const reordered = reorderAgentEntryItem(added, 1, 0);
    expect(reordered).toEqual({
      description: "kept",
      items: [{ provider: "claude" }, { ref: "base" }],
    });

    const edited = editAgentEntryItem(reordered, 0, { provider: "codex", model: "gpt-5" });
    expect(edited).toEqual({
      description: "kept",
      items: [{ provider: "codex", model: "gpt-5" }, { ref: "base" }],
    });

    expect(removeAgentEntryItem(edited, 1)).toEqual({
      description: "kept",
      items: [{ provider: "codex", model: "gpt-5" }],
    });
  });
});
