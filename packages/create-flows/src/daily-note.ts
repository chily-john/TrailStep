import { defineWorkflow, done, shape, step } from "@stepkit/sdk";

interface DailyNoteOutput extends Record<string, unknown> {
  readonly isDone: boolean;
}

const stepOne = step({ id: "write-note" })
  .prompt("Create a new file in the project root that contains a greeting in it.", {
    output: shape<DailyNoteOutput>({ isDone: "boolean" }),
  })
  .do(done);

export const dailyNote = defineWorkflow({
  id: "daily-note",
  description: "Asks a Claude agent to create a greeting file in the project root.",
  start() {
    return stepOne();
  },
});
