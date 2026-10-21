export interface CancelCommandArgs {
  readonly runNameOrRunDir?: string;
  readonly reason?: string;
  /** Remove a pending cancel.json marker without starting or cancelling anything. */
  readonly clear?: boolean;
}
