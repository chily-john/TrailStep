export class WorkflowResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowResolutionError";
  }
}
