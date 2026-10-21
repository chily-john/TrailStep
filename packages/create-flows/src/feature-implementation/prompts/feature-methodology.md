# Feature workflow methodology

## Planning principles

- Start from observable behavior and user value.
- Preserve uncertainty explicitly; do not invent missing product decisions.
- Prefer the smallest vertical slice that proves a complete path through the system.
- Slice by integration-visible value and risk, not by numeric story budgets.
- Split a story when it contains separable user-visible/integration-visible outcomes, independent risk seams, or hard dependency boundaries that can each be proven by distinct behavioral tests.
- Bundle work into the same story when splitting would create micro-stories, docs/package-metadata-only tasks, duplicate validation-only paths, or horizontal setup/refactor/test-only tasks that are not independently observable.
- Use tracer bullets to de-risk integration seams early with thin end-to-end behavior.
- Every implementation story must begin with a behavioral red test that fails for the right reason.
- The green phase should add only enough production code to pass the focused red test.
- Refactor only after focused tests pass, and keep refactors scoped to the feature.
- Dependencies are hard dependencies only: story B depends on story A when B cannot pass its own tests until A is complete.

## Review scoring

Score on a 1-5 integer scale:

- 5: excellent; strongly aligned with TDD, cost-aware vertical slicing, tracer-bullet risk reduction, dependency clarity, and local architecture.
- 4: good; acceptable with only minor non-blocking improvements.
- 3: incomplete; useful but needs material changes before continuing.
- 2: poor; misses core methodology or important requirements.
- 1: unusable; unsafe, incoherent, or not traceable to the feature.

Scores of 4 or 5 pass. Scores below 4 must list specific `requiredImprovements` so the next attempt can address them directly.
