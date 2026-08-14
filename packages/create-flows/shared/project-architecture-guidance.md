# Architecture awareness

Before naming files, choosing package/module boundaries, picking integration seams, or ordering stories/dependencies, ground the decision in the target project's own conventions rather than inventing structure:

- Look for and read the project's own architecture/convention docs at its root and nearby — `CLAUDE.md`, `AGENTS.md`, `.pi/rules/`, ADRs, architecture docs, or an equivalent README section.
- Prefer existing module/package boundaries, naming conventions, and file layout patterns already established in the project over introducing new ones.
- When the project's own guidance is silent or ambiguous on a non-trivial integration choice, say so explicitly as an assumption rather than silently picking one convention over another.
