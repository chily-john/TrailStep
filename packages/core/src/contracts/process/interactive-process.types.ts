/**
 * Interactive (human-in-the-loop) process contract.
 *
 * Lives under `contracts/` so that the built-in provider catalog
 * (`cli-provider-runtime/catalog`) and the run-workflow runtime can both
 * depend on it without importing each other. This module is a leaf: it
 * declares types only and imports nothing.
 */

export interface InteractiveProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit";
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface InteractiveProcessResult {
  readonly exitCode: number;
}

export type InteractiveProcessRunner = (
  request: InteractiveProcessRequest,
) => InteractiveProcessResult | Promise<InteractiveProcessResult>;
