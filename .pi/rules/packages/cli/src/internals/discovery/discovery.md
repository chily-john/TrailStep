---
kind: rules
paths:
  - packages/cli/src/internals/discovery/
summary: Workflow package discovery from consuming-project dependencies marked with the `stepkit-workflow` keyword.
triggers:
  - workflow discovery
  - stepkit-workflow keyword
  - package export
  - stepkit workflows
---

# packages/cli/src/internals/discovery/

Enter here when changing how the CLI finds workflow exports in a consuming project.

## Rules

- Discover workflows as `<packageName>:<exportName>` and include the resolved package directory for package-level checks; do not expose individual steps as public command units.
- Ignore default exports and non-workflow named exports.
- Entry-point resolution supports root `exports`, `module`, `main`, then `./index.js`; use `resolvePackageEntryFilePath` when callers need the same entry file discovery imports, and update tests when changing this order.
- Use `resolveInstalledPackageManifest` for shared installed-package `package.json` lookup; it falls back through resolvable entry files and conventional `node_modules` paths.
- Workflow shape detection accepts `inputShape`/`outputShape` and source-supported `input`/`output` schema fields, and requires `start` for discoverable workflows.
- Discovery is local dependency based; do not add registry/network discovery without a product decision.
