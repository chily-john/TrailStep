---
kind: rules
paths:
  - packages/testkit/src/
summary: Source and tests for `@stepkit/testkit` validation utilities.
triggers:
  - testkit source
  - testkit tests
  - validation utility
  - prompt assertion
  - workflow assertion
---

# packages/testkit/src/

Enter here when implementing reusable validation utilities for StepKit authors or package tests.

## Rules

- Design helpers around observable behavior and stable contracts, not package-internal implementation details.
- Coordinate with authoring/runtime rules before asserting prompt, event, or failure-shape specifics.
- Keep exports intentional and covered by tests because this package has a public package surface.
