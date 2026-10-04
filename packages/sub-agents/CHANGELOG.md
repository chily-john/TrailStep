# @trailstep/sub-agents

## 0.2.0

### Minor Changes

- 0390822: Introduce the public sub-agents package with delegate workflows, including the parallel delegate workflow export.
- db93d74: Align the shared agent pool across packages (`planner`, `explorer`, `quick-implementor`, `smart-implementor`, `debugger`, `reviewer`, `expert`, `formatter`, plus `generalist` with demanding-model fallback), extend `trailstep agents explain` to workflow routing (`namespace/name`), re-apply missing package `recommendedConfig` additively on `trailstep update` (never overwriting user values), surface `trailstep doctor` drift warnings, and emit a compact agent routing progress note for working-agent steps.

### Patch Changes

- Updated dependencies [4465267]
- Updated dependencies [432547d]
- Updated dependencies [f6013f5]
- Updated dependencies [796d814]
- Updated dependencies [763827d]
- Updated dependencies [71f0ffe]
- Updated dependencies [64ba8ae]
  - @trailstep/authoring@0.2.0
