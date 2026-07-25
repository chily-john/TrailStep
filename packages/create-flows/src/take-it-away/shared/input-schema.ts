import { shape } from "@stepkit/sdk";

export interface TakeItAwayInput extends Record<string, unknown> {
  readonly conversation: string;
}

export const takeItAwayInput = shape<TakeItAwayInput>({ conversation: "string" });
