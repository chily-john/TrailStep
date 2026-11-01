---
"@trailstep/core": patch
---

Fix Windows provider spawns and make JSON extraction brace-safe.

- `resolveCliCommandForSpawn` now reads the Node entrypoint out of pnpm-generated `.cmd` shims (`"%~dp0\..\pkg\cli.js" %*`), not just npm's (`"%dp0%\..\pkg\cli.js" %*`). pnpm shims previously fell through to `cmd.exe /c`, which re-parses the argument list, so any prompt containing `&`, `|`, `<`, `>`, `^`, `%` or `!` was reinterpreted by the shell. The failure was content-dependent and looked intermittent.
- A `.cmd` shim whose entrypoint cannot be resolved now throws a clear error instead of silently launching through `cmd.exe`. Provider CLIs must be resolvable to a Node entrypoint; the `--project`/prompt argv is never handed to a shell.
- New `extractJsonObject` in `@trailstep/core` extracts the first balanced JSON object using a real scanner that tracks string literals and escapes and tries ```json fenced blocks first. It replaces the previous "slice from the first `{` to the last `}`" logic in both the envelope parser and the manifest output writer, which produced unparseable output whenever model prose contained an extra brace.
- `extractEnvelopeText` (raw-text capture mode) continues to return the agent's answer verbatim and deliberately does not use the extractor.
