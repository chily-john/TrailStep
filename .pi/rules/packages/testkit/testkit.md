---
kind: rules
paths:
  - packages/testkit/
summary: `@stepkit/testkit` package for reusable workflow and step validation helpers.
triggers:
  - '@stepkit/testkit'
  - testkit package
  - validation helper
  - workflow testing
  - prompt testing
---

# packages/testkit/

Enter here for reusable testing utilities that validate StepKit workflow behavior rather than one package's internal implementation.

## Areas

- `src/`: Enter when changing exported testkit helpers or package tests.
- `package.json`: Enter when package metadata, exports, build scripts, or publish files for `@stepkit/testkit` change.
- `README.md`: Enter when publish-facing validation-helper guidance changes.

## Rules

- Design helpers around observable behavior and stable contracts: workflows, prompt rendering, runtime events, failure paths, and validation hooks.
- Coordinate with current core/runtime source before asserting event or failure-shape specifics.
