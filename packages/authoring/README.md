# @trailstep/authoring

`@trailstep/authoring` provides TypeScript helpers for writing TrailStep workflows.

## Install

```bash
pnpm add @trailstep/authoring
```

## Public role

Use this package to author workflows with:

- `defineWorkflow({ start })` as the workflow definition boundary.
- `step(...)` for continuation steps.
- `done(...)` for successful completion.

Export workflows from a Node-readable module. Consumers can run direct refs such as `./workflows/sample.ts#sampleWorkflow`, register refs with `trailstep add`, or use bundle refs when a package exposes a TrailStep workflow manifest.

## Packaging prompt fragments

If a published workflow imports markdown prompt fragments, prefer bundling them into the workflow entrypoint so the installed package has no runtime file-path assumptions. With `tsup`, use raw imports plus the text loader:

```ts
import methodology from "./methodology.md?raw";

const promptFragment = methodology.trimEnd();
```

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --sourcemap --clean --loader .md=text"
  }
}
```

Add a declaration for TypeScript:

```ts
declare module "*.md?raw" {
  const content: string;
  export default content;
}
```

`loadFragments(import.meta.dirname, ...)` is useful for local source workflows or packages that deliberately ship copied asset files, but publishable bundled workflow packages must either inline those fragments or include copied assets in `files` at the exact runtime paths used by the built bundle.
