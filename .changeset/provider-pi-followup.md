---
"@trailstep/provider-pi": minor
---

Add `followUp` support to the pi provider manifest (`sessionIdFlag: --session-id`, `resumeArgs` with `--session {{sessionId}}`). This enables the core two-phase working-agent flow: Phase 1 runs the work prompt, Phase 2 resumes the same pi session to reformat the report into the strict output schema, so long implement turns no longer fail output validation after doing the work.
