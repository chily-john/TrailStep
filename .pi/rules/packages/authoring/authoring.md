---
kind: rules
paths:
  - packages/authoring/
summary: '`@stepkit/authoring` package for TypeScript workflow authoring APIs layered over core.'
triggers:
  - '@stepkit/authoring'
  - authoring package
  - authoring API
  - workflow builder
  - prompt rendering
  - loadFragments
  - prompt fragments
  - md prompt fragments
  - tsup loader
---

# packages/authoring/

Enter here for author-facing TypeScript APIs that make workflows and steps ergonomic to define. `@stepkit/authoring` should stay thin over `@stepkit/core`.

## Areas

- `src/`: Enter when adding or changing authoring exports, builders, authoring helpers, or authoring behavior tests.
- `package.json`: Enter when package metadata, exports, dependencies, build scripts, or publish files for `@stepkit/authoring` change.
- `README.md`: Enter when publish-facing authoring usage guidance changes.

## Rules

- New workflow examples should use `defineWorkflow({ id, agents, inputShape, outputShape, start })`, fluent `step({ id, ... }).prompt(...).next(...)`, `done(...)`, `fail(...)`, and `promptTemplate(...)` when a local prompt file is needed.
- Published `@stepkit/authoring` keeps `@stepkit/core` as both a `workspace:*` build dependency and a `^0.0.0` peer dependency.
- Keep deterministic prompt rendering visible and testable from typed input.
- Do not make individual steps public discovery units unless product direction changes first.

## Blessed pattern: bundling `.md` prompt fragments with `tsup`

Any first-party workflow package that already builds with `tsup` (currently all of them) and wants markdown prompt fragments alongside its prompt files should prefer plain ESM `.md` imports over `loadFragments`'s runtime file reads. This is the replicable recipe (`packages/create-flows` is the reference implementation):

1. Add `--loader ".md=text"` to the package's existing `tsup` build script in `package.json`, for example: `tsup src/index.ts --format esm --dts --sourcemap --clean --loader ".md=text"`. This makes tsup treat `.md` imports as inlined string literals, so they survive normal single-file bundling with no non-bundled build mode and no fragment-copy step.
2. Add an ambient module declaration so `tsc --noEmit` accepts the imports, in a `global.d.ts` (or similarly-named) file under `src/` that the package's `tsconfig.json` `include` glob already covers:
   ```ts
   declare module "*.md" {
     const content: string;
     export default content;
   }
   ```
3. In prompt files, import fragments as plain default imports instead of calling `loadFragments`, for example:
   ```ts
   import methodology from "../shared/feature-methodology.md";
   ```
   and reference `methodology` directly rather than building a `fragments` object.

**Caveat — vitest/vite tests, if the package has any:** the `--loader` flag above only configures `tsup`'s build (esbuild); it does nothing for `vitest run`, which uses Vite's own transform pipeline. Vite's default behavior for an unrecognized extension like `.md` is to treat it as a static asset and resolve the import to a URL string, not inlined text — silently wrong content, not a build error. If a package following this pattern adds vitest tests that exercise a prompt file (or anything else importing a `.md` fragment), also add a matching text-loader plugin to its `vitest.config.ts` (see `packages/authoring/vitest.config.ts` for this package's existing config shape), for example:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "md-as-text",
      transform(code, id) {
        if (id.endsWith(".md")) {
          return `export default ${JSON.stringify(code)};`;
        }
      },
    },
  ],
});
```
`packages/create-flows` currently has no test files, so this gap is undocumented-but-latent there — add the plugin the moment that package (or any future one following this recipe) gains tests that touch a `.md`-importing module.

This is the recommended default, not a mandate. `loadFragments` (exported here, backed by `@stepkit/core`'s `packages/core/src/authoring/prompt-composition/prompt-composition.ts`) still exists and remains a legitimate choice for anyone who genuinely wants literal runtime file reads with zero bundler assumptions — for example a package that intentionally does not bundle, or that needs to read fragment files that are not known at build time. See `.pi/rules/packages/create-flows/create-flows.md` for this pattern applied to a concrete package.
