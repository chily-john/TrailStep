---
"@trailstep/cli": minor
"@trailstep/mcp": patch
---

Make cancelled runs continuable and keep generated MCP tools in step with the
workflows they describe.

- A cancelled run can be continued again. The cancellation marker is consumed
  when the run is continued, so a cancelled run is no longer permanently
  unrunnable, and `trailstep cancel --clear` removes a pending cancellation
  without starting a run.
- The CLI cancel command now creates events through the core helpers, so it
  emits conforming event ids and appends through the shared append path
  instead of a hand-rolled id and a raw append that could interleave with
  the live run. A cancelled run always reaches its terminal cancelled event.
- `trailstep remove` now deletes the generated MCP tool JSON for the workflow
  it removes, and the MCP server skips per-workflow tool files whose workflow
  no longer resolves, so a removed workflow stops publishing a dead tool.
- The MCP server reuses the core MCP config parsing instead of re-implementing
  it, which removes a source of drift between the two.
