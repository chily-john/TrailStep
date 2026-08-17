export type UpdateScope =
  | { kind: "global" }
  | { kind: "project" }
  | { kind: "all" }
  | { kind: "workflows" }
  | { kind: "workflow"; name: string };

export interface UpdateCommandArgs {
  scope: UpdateScope;
  force: boolean;
  assumeYes: boolean;
}
