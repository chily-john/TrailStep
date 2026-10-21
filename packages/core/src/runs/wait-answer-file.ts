/**
 * Atomic persistence of a wait answer artifact.
 *
 * The answer file lives inside the run directory; a concurrent continue must
 * never read a half-written answer. The write is a temp file + rename in the
 * same directory (the shared `atomicWriteJson` runtime primitive).
 */
import { atomicWriteJson } from "../runtime/artifacts/run-storage.js";

/**
 * Write the wait answer payload into the run's answer artifact atomically.
 *
 * @param answerFile Absolute path of the answer artifact.
 * @param answer JSON payload persisted verbatim.
 */
export async function writeWaitAnswerFile(answerFile: string, answer: unknown): Promise<void> {
  await atomicWriteJson(answerFile, answer);
}
