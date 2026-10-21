---
"@trailstep/cli": patch
---

Register the TrailStep MCP server with pi by writing pi's `mcp.json` entry directly instead of going through `add-mcp`.

pi's `exposure` / `toolExposure` keys are pi-only concepts that `add-mcp` cannot express, so every pi user used to get the default whole-server `codemode` exposure. The direct write now applies an exposure profile that keeps the generic run-loop tools (`trst_run_workflow`, `trst_watch`, `trst_answer`, `trst_resume`) `direct` while the large-schema per-workflow `trst_*` tools stay `codemode`. The scope-to-path mapping is fixed as well: project and local scope write `<project>/.pi/mcp.json`, global scope writes `$PI_CODING_AGENT_DIR` (or `~/.pi/agent`) `mcp.json`, and pi is excluded from the `add-mcp` agent list so no competing user-level entry is written. The write is atomic, preserves other servers and unknown top-level keys, never clobbers a differently-configured entry, and never fails the run: it warns and prints the manual `pi mcp add <name> -- <command> <args...>` command instead. Every other coding agent keeps the existing `add-mcp` path.
