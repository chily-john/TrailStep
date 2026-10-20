export const trailtestPackageMarker = "@trailstep/trailtest";

export const testkitPackageMarker = trailtestPackageMarker;

export { expectEventSequence } from "./expect-event-sequence.js";
export {
  type FakeOutputRoute,
  type FakeOutputRouteInput,
  fakeOutputFileHandler,
} from "./fake-output-file-handler.js";
export {
  type RunWorkflowWithStubsOptions,
  runWorkflowWithStubs,
  stubSubWorkflow,
} from "./run-workflow-with-stubs.js";
export { cleanupTmpProjects, tmpGitRepo, tmpProject } from "./sandbox.js";
