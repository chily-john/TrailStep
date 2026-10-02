# Implementation strategy format

`implementation-strategy.md` captures architecture and risk planning before executable story slicing.

Use this structure:

```markdown
# Implementation Strategy: <Feature Name>

## Objective and Scope

## Architecture Approach

## Key Files and Integration Points

## Risk Plan

## Testing Strategy

## Slicing Guidance
```

Rules:

- Do not include `<!-- trailstep-story-boundary -->` or any other TrailStep story boundary markup.
- Do not write executable story bodies in this artifact.
- Focus on architecture, risk, sequencing rationale, tracer-bullet path, hard dependencies, and validation strategy.
- Preserve uncertainty as assumptions or explicit risks instead of guessing.
