# Feature doc format

`feature-doc.md` is an intermediate, scope-preserving feature description used as input to implementation planning. It should distill the real request without turning it into an idealized product specification.

Use this structure:

```markdown
# <Feature Name>

## Must-Have Outcome

Summarize the smallest confirmed outcome the user actually requested. Prefer the user's concrete wording and avoid expanding into adjacent product vision.

## Users / Jobs / Pain

## In-Scope Proposed Behavior

Describe only behavior needed for the must-have outcome. If something seems useful but was not requested or is uncertain, keep it out of this section.

## Explicit Non-Goals

List non-goals, exclusions, and scope limits explicitly stated by the conversation. Include strongly implied exclusions only when tied to clear evidence. If none were stated, say so instead of inventing exclusions.

## Examples and Acceptance Criteria

## Edge Cases and Failure Modes

## Affected Areas and Integration Points

## Testing Expectations

## Documentation / Migration / Rollout Notes

## Assumptions and Open Questions

Capture missing product decisions, uncertain details, and assumptions required for planning. Do not resolve uncertainty by inventing answers.

## Conversation Context Worth Preserving

Record constraints, rationale, terminology, user preferences, tradeoffs, and notable uncertainty that a planner or implementer should know without rereading the full conversation.

## Optional / Future Ideas

List explicitly mentioned nice-to-haves, possible follow-ups, or adjacent ideas separately from the current implementation scope. These ideas are not acceptance criteria unless the conversation explicitly makes them must-haves.
```

The document should be detailed enough that another agent can plan implementation without reading the original conversation, while still preserving important uncertainty and scope boundaries.
