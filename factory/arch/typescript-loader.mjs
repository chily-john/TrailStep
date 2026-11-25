/**
 * Source-mode module hooks for the architecture CLI.
 *
 * Node's built-in TypeScript stripping runs `.ts` files directly, but it does
 * not rewrite the `.js` specifiers TypeScript emits (`./cli.js` on disk is
 * `./cli.ts`). Register this from the launcher, or with
 * `node --import ./factory/arch/typescript-loader.mjs`, before any `.ts` entry
 * is loaded.
 *
 * Only a missing JavaScript file is redirected to its TypeScript sibling, so a
 * real built file still wins if one is ever placed beside the source.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

/** The TypeScript target written by tsc for each JavaScript module extension. */
const TYPESCRIPT_SIBLING = new Map([
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
]);

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: { parentURL?: string }) => unknown} nextResolve
 */
function resolveTypeScriptSibling(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith("file:") && specifier.startsWith(".")) {
    const url = new URL(specifier, context.parentURL);

    for (const [javascriptExtension, typescriptExtension] of TYPESCRIPT_SIBLING) {
      if (!url.pathname.endsWith(javascriptExtension)) {
        continue;
      }

      const sourceUrl = new URL(url.href);
      sourceUrl.pathname = `${url.pathname.slice(0, -javascriptExtension.length)}${typescriptExtension}`;

      if (!existsSync(url) && existsSync(sourceUrl)) {
        return { url: sourceUrl.href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}

registerHooks({ resolve: resolveTypeScriptSibling });
