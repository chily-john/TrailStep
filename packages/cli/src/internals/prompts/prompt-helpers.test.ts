import { describe, expect, it } from "vitest";

import { promptSelect, promptText, promptYesNo } from "./prompt-helpers.js";

describe("promptText", () => {
  it("returns the explicit value without prompting", async () => {
    await expect(promptText("Label", "given", undefined, "usage hint")).resolves.toBe("given");
  });

  it("throws the usage hint when no value and no prompts are available", async () => {
    await expect(promptText("Label", undefined, undefined, "usage hint")).rejects.toThrow(
      "usage hint",
    );
  });

  it("prompts and trims the answer when no explicit value is given", async () => {
    await expect(
      promptText(
        "Label",
        undefined,
        { text: async () => "  answer  ", select: async () => "" },
        "hint",
      ),
    ).resolves.toBe("answer");
  });

  it("throws when the interactive answer is blank", async () => {
    await expect(
      promptText("Label", undefined, { text: async () => "   ", select: async () => "" }, "hint"),
    ).rejects.toThrow("Label is required.");
  });
});

describe("promptSelect", () => {
  it("throws the usage hint when no prompts are available", async () => {
    await expect(promptSelect("Label", ["a", "b"], undefined, "usage hint")).rejects.toThrow(
      "usage hint",
    );
  });

  it("returns the selected choice", async () => {
    await expect(
      promptSelect("Label", ["a", "b"], { text: async () => "", select: async () => "b" }, "hint"),
    ).resolves.toBe("b");
  });

  it("throws when the selection is not one of the choices", async () => {
    await expect(
      promptSelect("Label", ["a", "b"], { text: async () => "", select: async () => "c" }, "hint"),
    ).rejects.toThrow("Invalid selection for Label: c");
  });
});

describe("promptYesNo", () => {
  it("returns true for yes and false for no", async () => {
    await expect(
      promptYesNo("Label", { text: async () => "", select: async () => "yes" }, "hint"),
    ).resolves.toBe(true);
    await expect(
      promptYesNo("Label", { text: async () => "", select: async () => "no" }, "hint"),
    ).resolves.toBe(false);
  });
});
