import { defineWorkflow, done, shape, step } from "@stepkit/sdk";

interface DailyNoteOutput extends Record<string, unknown> {
  readonly isDone: boolean;
}

const outputShape = shape<DailyNoteOutput>({ isDone: "boolean" });

const stepOne = step({ id: "write-note", outputShape })
  .prompt("Create a new file in the project root that contains a greeting in it.")
  .next(done);

export const dailyNote = defineWorkflow({
  id: "daily-note",
  description: "Asks a Claude agent to create a greeting file in the project root.",
  start() {
    return stepOne();
  },
});
