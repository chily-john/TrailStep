---
kind: rules
paths:
  - packages/authoring/src/shared/
summary: Authoring-only builder validation helpers shared by authoring APIs.
triggers:
  - builder validation
  - assertBuilderObject
  - authoring shared helper
---

# packages/authoring/src/shared/

Enter here when changing validation utilities used by authoring builders. These helpers should validate authoring API shape at the authoring boundary without adding runtime execution semantics.

## Rules

- Keep error messages author-facing and specific to the builder that called the helper.
- Do not import core runtime modules here; shared authoring helpers should stay lightweight.
- Add tests through the calling builder when helper behavior affects public authoring APIs.
