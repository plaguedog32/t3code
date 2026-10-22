import type * as EffectAcpSchema from "effect-acp/compat";
import { describe, expect, it } from "vite-plus/test";

import { copilotModels, copilotModelsFromSession } from "./status.ts";

const modelOption = (
  options: ReadonlyArray<{ value: string; name: string }>,
): EffectAcpSchema.SessionConfigOption => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "auto",
  options: [...options],
});

describe("copilotModelsFromSession", () => {
  it("reads the model option and drops Copilot's repeated rows", () => {
    const models = copilotModelsFromSession(
      [
        modelOption([
          { value: "auto", name: "Auto" },
          { value: "auto", name: "Auto" },
          { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        ]),
      ],
      undefined,
    );
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["auto", "Auto", true],
      ["claude-sonnet-4.5", "Claude Sonnet 4.5", false],
    ]);
  });

  it("falls back to the session model state", () => {
    const models = copilotModelsFromSession([], {
      currentModelId: "gpt-5",
      availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
    });
    expect(models.map((model) => model.slug)).toEqual(["gpt-5"]);
  });
});

describe("copilotModels", () => {
  it("always offers Auto and keeps custom models", () => {
    const models = copilotModels({ customModels: ["my-byok-model"] }, []);
    expect(models.map((model) => [model.slug, model.isCustom])).toEqual([
      ["auto", false],
      ["my-byok-model", true],
    ]);
  });

  it("does not repeat Auto once a session listed it", () => {
    const discovered = copilotModelsFromSession(
      [
        modelOption([
          { value: "auto", name: "Auto" },
          { value: "gpt-5", name: "GPT-5" },
        ]),
      ],
      undefined,
    );
    expect(copilotModels({ customModels: [] }, discovered).map((model) => model.slug)).toEqual([
      "auto",
      "gpt-5",
    ]);
  });
});
