/**
 * Failure-shape guards.
 *
 * The implementations live in the failure contract so the public entrypoint
 * can export them without reaching into the runtime internals.
 */
export {
  isFailureLikeError,
  readFailureCode,
} from "../../contracts/failures/failure.js";
