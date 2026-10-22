import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import { CopilotSettings } from "../settings.ts";
import { makeCopilotAcpRuntime } from "./acpSupport.ts";
import {
  copilotClientCapabilitiesMeta,
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
} from "./copilotAcp.ts";
import { copilotModelsFromSession } from "./status.ts";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const CopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // Permissions are launch flags, so a mode change needs a new process.
    supportsRuntimeModeSwitchInSession: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/**
 * Explicit approval or sandbox overrides launch Copilot asking, so every
 * mutating request reaches T3's policy check instead of a launch-time grant.
 */
function copilotLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

interface CopilotAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Copilot lists the account's models only inside a session. */
  readonly onModelsDiscovered?: (models: ReadonlyArray<ServerProviderModel>) => Effect.Effect<void>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeCopilotAcpAdapterFlavor(options: CopilotAdapterV2Options): AcpAdapterV2Flavor {
  const routing = makeCopilotSubagentRouting();
  const onModelsDiscovered = options.onModelsDiscovered;
  return {
    driver: COPILOT_PROVIDER,
    runtimeHarness: "GitHub Copilot",
    capabilities: CopilotProviderCapabilitiesV2,
    customModels: readCustomModelEntries(options.settings.customModels).map((entry) => entry.slug),
    clientCapabilitiesMeta: copilotClientCapabilitiesMeta,
    registerExtensions: routing.registerExtensions,
    normalizeSessionUpdate: routing.normalizeSessionUpdate,
    extractSubagentUpdate: extractCopilotSubagentUpdate,
    supportsCompaction: true,
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeCopilotAcpRuntime({
          ...input,
          settings: options.settings,
          environment: { ...options.environment, ...processEnvironment },
          runtimeMode: copilotLaunchRuntimeMode(runtimePolicy),
        })),
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? { message: cause.errorMessage, code: String(cause.code), class: "provider_error" }
          : { class: "provider_error" }),
      }),
    ...(onModelsDiscovered === undefined
      ? {}
      : {
          onSessionConfigurationUpdate: (configOptions, _modeState, modelState) => {
            const models = copilotModelsFromSession(configOptions, modelState);
            return models.length > 0 ? onModelsDiscovered(models) : Effect.void;
          },
        }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeCopilotAdapterFromInput = Effect.fn("makeCopilotAdapterFromInput")(
  function* (
    input: ProviderAdapterDriverCreateInput<CopilotSettings> & {
      readonly onModelsDiscovered?: CopilotAdapterV2Options["onModelsDiscovered"];
    },
  ) {
    const { onModelsDiscovered } = input;
    const hostEnvironment = yield* HostProcess.Environment;
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeCopilotAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      selfInvocation: yield* resolveSelfInvocation(),
      continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
      ...(onModelsDiscovered === undefined ? {} : { onModelsDiscovered }),
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: COPILOT_PROVIDER,
          threadId,
        }),
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: COPILOT_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create GitHub Copilot ACP adapter.",
            cause,
          }),
      ),
    ),
);

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  CopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_PROVIDER,
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => DEFAULT_COPILOT_SETTINGS,
  create: (input) => makeCopilotAdapterFromInput(input),
};
