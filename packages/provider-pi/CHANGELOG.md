# @trailstep/provider-pi

## 0.2.0

### Minor Changes

- 322bb12: Add `followUp` support to the pi provider manifest (`sessionIdFlag: --session-id`, `resumeArgs` with `--session {{sessionId}}`). This enables the core two-phase working-agent flow: Phase 1 runs the work prompt, Phase 2 resumes the same pi session to reformat the report into the strict output schema, so long implement turns no longer fail output validation after doing the work.

## 0.1.1

### Patch Changes

- 05fcb88: Publish provider-agnostic runtime support, provider package registration flows, and official provider packages.
