import type { ModelCapabilities, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import type { CopilotSettings } from "../settings.ts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import type * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";
import {
  COPILOT_DEFAULT_MODEL_SLUG,
  COPILOT_SUPPORTED_RUNTIME_MODES,
  copilotAuthFromSources,
  copilotConfigPath,
} from "./acpSupport.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  supportsConversationRollback: false,
  // Copilot's plan mode is a session mode T3's plan toggle does not drive.
  showInteractionModeToggle: false,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const SIGN_IN_MESSAGE =
  "Could not confirm a GitHub Copilot sign-in. Run `copilot login` if sessions fail.";

const AUTO_MODEL: ServerProviderModel = {
  slug: COPILOT_DEFAULT_MODEL_SLUG,
  name: "Auto",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

/**
 * Copilot lists its account's models only in an open session, and a status
 * check must not open one (it would start MCP servers and hooks). Models seen
 * in real sessions are therefore remembered by the driver and merged here.
 */
export function copilotModels(
  settings: Pick<CopilotSettings, "customModels">,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const builtIn = discovered.some((model) => model.slug === COPILOT_DEFAULT_MODEL_SLUG)
    ? discovered
    : [AUTO_MODEL, ...discovered];
  return providerModelsFromSettings(builtIn, settings.customModels, EMPTY_CAPABILITIES);
}

/** Copilot repeats some choices (two "auto" rows), so slugs are deduplicated. */
export function copilotModelsFromSession(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions.find(
    (option) => option.type === "select" && (option.category === "model" || option.id === "model"),
  );
  const entries =
    modelOption?.type === "select"
      ? flattenSelectChoices(modelOption.options).map((choice) => ({
          id: choice.value,
          name: choice.name,
        }))
      : (modelState?.availableModels.map((model) => ({ id: model.modelId, name: model.name })) ??
        []);
  const seen = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    const slug = entry.id.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name.trim() || slug,
        isCustom: false,
        ...(slug === COPILOT_DEFAULT_MODEL_SLUG ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

export const buildInitialCopilotProviderSnapshot = Effect.fn(
  "CopilotProviderStatus.buildInitialCopilotProviderSnapshot",
)(function* (settings: CopilotSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: copilotModels(settings, []),
    probe: {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking GitHub Copilot CLI availability..."
        : "GitHub Copilot is disabled in T3 Code settings.",
    },
  });
});

const readCopilotConfig = Effect.fn("CopilotProviderStatus.readCopilotConfig")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  return yield* fileSystem
    .readFileString(copilotConfigPath(environment, home, path.join))
    .pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

/**
 * Runs `copilot --version` and reads the stored login. It never starts an ACP
 * session, so it cannot open a browser login or boot MCP servers.
 */
export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  discoveredModels: ReadonlyArray<ServerProviderModel>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = copilotModels(settings, discoveredModels);
  const draft = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return draft({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "GitHub Copilot is disabled in T3 Code settings.",
    });
  }

  const command = settings.binaryPath || "copilot";
  const versionResult = yield* Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    yield* Effect.logWarning("GitHub Copilot CLI health check failed.", {
      errorTag: versionResult.failure._tag,
    });
    return draft({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
        : "Failed to execute GitHub Copilot CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return draft({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI timed out while running `copilot --version`.",
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI is installed but failed to run.",
    });
  }

  const auth = copilotAuthFromSources({
    environment,
    configText: yield* readCopilotConfig(environment),
  });
  return draft({
    installed: true,
    version,
    status: auth.status === "authenticated" ? "ready" : "warning",
    auth,
    ...(auth.status === "authenticated" ? {} : { message: SIGN_IN_MESSAGE }),
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
