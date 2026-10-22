import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

import { CopilotSettings } from "../settings.ts";
import { makeCopilotAdapterFromInput, type CopilotAdapterV2DriverEnv } from "./adapter.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  enrichCopilotSnapshot,
} from "./status.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";
import { copilotUsageReader } from "./usage.ts";
import { readCopilotAccount } from "./usageLimits.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const DRIVER_KIND = ProviderDriverKind.make("copilot");

// npm installs update through npm. Copilot's own `copilot update` cannot be
// trusted to know its installer (WinGet, Homebrew, the install script), so
// other installs stay manual.
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@github/copilot",
  nativeUpdate: null,
});

export type CopilotDriverEnv =
  | CopilotAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  usage: copilotUsageReader,
  create: Effect.fn("CopilotDriver.create")(function* (input) {
    const { instanceId, displayName, accentColor, environment, enabled, config } = input;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Scope.Scope;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;
    const driverError = (detail: string) => (cause: unknown) =>
      new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail, cause });

    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );

    const discoveredModels = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
    const checkProvider = Ref.get(discoveredModels).pipe(
      Effect.flatMap((models) => checkCopilotProviderStatus(effectiveConfig, processEnv, models)),
      Effect.flatMap((status) =>
        effectiveConfig.enabled && status.installed && status.auth.status === "authenticated"
          ? readCopilotAccount(processEnv, status.auth.email).pipe(
              Effect.map(({ plan, usageLimits }) => ({
                ...status,
                auth: plan ? { ...status.auth, label: plan } : status.auth,
                usageLimits,
              })),
            )
          : Effect.succeed(status),
      ),
      Effect.map(stampIdentity),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCopilotProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichCopilotSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(Effect.mapError(driverError("Failed to build GitHub Copilot snapshot.")));

    // The model list only changes when the account's plan or Copilot's catalog
    // does, so a refresh runs only when a session reports a different list.
    const onModelsDiscovered = (models: ReadonlyArray<ServerProviderModel>) =>
      Ref.modify(discoveredModels, (current) => [
        JSON.stringify(current) !== JSON.stringify(models),
        models,
      ]).pipe(
        Effect.flatMap((changed) =>
          changed ? snapshot.refresh.pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void,
        ),
      );

    const orchestrationAdapter = yield* makeCopilotAdapterFromInput({
      ...input,
      onModelsDiscovered,
    }).pipe(Effect.mapError(driverError("Failed to build GitHub Copilot orchestration adapter.")));
    const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
