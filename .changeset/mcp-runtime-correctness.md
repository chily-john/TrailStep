---
"@trailstep/mcp": minor
"@trailstep/cli": patch
---

Make the MCP server correct under real-world conditions.

The MCP tools are thin adapters over the real CLI seams, and several of them
were not correct:

- `trst_watch` resolved runs under a hardcoded `<cwd>/.trailstep/runs` and
  ignored `TRAILSTEP_RUNS_ROOT`, so a run started under a custom runs root
  could not be watched by name. It now resolves the runs root the same way
  the rest of the system does.
- `trst_run_workflow` reported `status: "started"` even when the background
  process never started. It now verifies that the run materialized and reports
  `status: "failed"` with an error when it did not.
- The Windows path fallback spawned the CLI through `cmd.exe` with the
  `--input` JSON unquoted, which mangled the input. The fallback is now
  refused with a clear pointer to `TRAILSTEP_CLI_ENTRY`.
- The watch cursor wrote its temp file to a path that collided between
  overlapping watch calls in one process, so two calls could clobber each
  other's cursor. The temp name is now unique per write.
- `trst_resume` spawned the continue process without the caller's
  environment, so a caller-supplied `TRAILSTEP_RUNS_ROOT` or
  `TRAILSTEP_CLI_ENTRY` applied to resolution but not to the run.
- `trst_answer` discarded the persisted-answer report when the follow-up
  continue failed. It now returns `persisted: true` together with the
  continue error, so the caller can tell the answer was saved.
