import { defineWorkflow, done, shape, step } from "@stepkit/sdk";

interface DailyNoteOutput extends Record<string, unknown> {
  readonly isDone: boolean;
}

const inputShape = shape<Record<string, unknown>>({});
const outputShape = shape<DailyNoteOutput>({ isDone: "boolean" });

export const dailyNote = defineWorkflow({
  id: "daily-note",
  name: "Daily note",
  description: "Asks a Claude agent to create a greeting file in the project root.",
  agents: {
    basic: { size: "small" },
  },
  inputShape,
  outputShape,
  start() {
    return step({ id: "write-note", agent: "basic", outputShape })
      .prompt(() => "Create a new file in the project root that contains a greeting in it.")
      .next((output) => done(output))({});
  },
});
