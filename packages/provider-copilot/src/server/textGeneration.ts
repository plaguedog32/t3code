import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { CopilotSettings } from "../settings.ts";
import { makeCopilotAcpRuntime } from "./acpSupport.ts";

const COPILOT_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: TextGenerationOperations.Runner = Effect.fn("CopilotTextGeneration.run")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const output = yield* Ref.make("");
      // Launched asking, so a tool call the model attempts is never auto-approved.
      const runtime = yield* makeCopilotAcpRuntime({
        settings,
        environment,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(output, (current) => current + text);
      });

      const result = yield* Effect.gen(function* () {
        yield* runtime.start();
        const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
        const model = modelSelection.model.trim();
        if (
          modelOption?.type === "select" &&
          model.length > 0 &&
          modelOption.currentValue !== model &&
          flattenSelectChoices(modelOption.options).some((choice) => choice.value === model)
        ) {
          yield* runtime.setConfigOption(modelOption.id, model);
        }
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(COPILOT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "GitHub Copilot ACP request timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      const text = (yield* Ref.get(output)).trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail:
            result.stopReason === "cancelled"
              ? "GitHub Copilot ACP request was cancelled."
              : "GitHub Copilot returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "GitHub Copilot", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "GitHub Copilot ACP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "CopilotTextGeneration",
    TextGenerationOperations.withoutInvestigation("GitHub Copilot", run),
  );
});
