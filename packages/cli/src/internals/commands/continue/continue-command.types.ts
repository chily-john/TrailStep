export type ContinueCommandArgs =
  | { readonly mode: "select" }
  | { readonly mode: "interactive-file"; readonly path: string }
  | { readonly mode: "session-file"; readonly path: string }
  | { readonly mode: "json-file"; readonly path: string }
  | { readonly mode: "json"; readonly json: string };
