---
"@trailstep/create-flows": patch
---

Refresh grill-it-away and take-it-away workflow contracts in their published descriptions.

- The `grill-it-away` workflow description now states that grilling is interactive and waits for the user between follow-up questions: watch the run with `trst_watch`, answer the pending wait with `trst_answer`, and continue with `trst_resume` while the user responds; once confident, it hands off the full raw conversation transcript to feature implementation.

- The `take-it-away` workflow description now documents that `conversation` is required and must be the full raw transcript of the conversation or feature request (not a summary), that `autoCommit` defaults to true, that `pullRequest` defaults to enabled (base `main`, remote `origin`, draft false) with optional title/body, and that `planningCheckpoint` defaults to disabled.

No changes to workflow authoring APIs or persisted event schemas.
