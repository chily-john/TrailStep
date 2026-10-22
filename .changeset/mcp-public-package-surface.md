---
"@trailstep/mcp": minor
---

Publish the MCP package with a declared public surface and complete npm
metadata.

The MCP package was published without an `exports` map, without `bugs` and
`homepage` metadata, and without a `LICENSE` file in its tarball, and it was
not covered by the repository's public-package checks - so none of that was
caught before a release.

- The package now declares its public entry point through `exports`, matching
  every other published TrailStep package. The `./package.json` subpath stays
  reachable, because the CLI resolves it to locate the `add-mcp` binary.
  BREAKING (minor, because the package is pre-1.0): deep imports such as
  `@trailstep/mcp/dist/tools/trst_watch.js` no longer resolve. Import from
  `@trailstep/mcp` instead.
- The `bugs` and `homepage` metadata are now declared, and the tarball
  includes the `LICENSE` file the manifest already promised.
- The package is now part of the public-package metadata check and the npm
  pack dry-run, so a packaging mistake fails CI instead of a release.
