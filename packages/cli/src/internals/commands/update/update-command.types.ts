export type UpdateScope =
  | { kind: "self" }
  | { kind: "all" }
  | { kind: "workflows" }
  | { kind: "workflow"; name: string };

export interface UpdateCommandArgs {
  scope: UpdateScope;
  force: boolean;
  assumeYes: boolean;
}
