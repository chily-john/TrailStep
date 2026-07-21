export type ContinueCommandArgs =
  | { readonly mode: "session-file"; readonly path: string }
  | { readonly mode: "json-file"; readonly path: string }
  | { readonly mode: "json"; readonly json: string };
