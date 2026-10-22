import type { RuntimeMode, ServerProviderAuth } from "@t3tools/contracts";
import type { CopilotSettings } from "../settings.ts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

/**
 * Copilot's own model id for "let Copilot pick". Unlike other drivers'
 * default sentinels it is a real choice the ACP `model` option offers.
 */
export const COPILOT_DEFAULT_MODEL_SLUG = "auto";

/**
 * Modes Copilot enforces itself through launch flags. `--allow-tool=write`
 * approves file edits while shell, MCP, path, and URL requests still ask.
 * There is no classifier mode to back T3's Auto.
 */
export const COPILOT_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/**
 * Background probes and sessions must not replace the binary under T3's feet;
 * updates go through provider maintenance instead.
 */
export function copilotAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  const base = ["--acp", "--no-auto-update"];
  switch (runtimeMode) {
    case "full-access":
      return [...base, "--allow-all"];
    case "auto-accept-edits":
      return [...base, "--allow-tool=write"];
    default:
      return base;
  }
}

function buildCopilotAcpSpawnInput(input: {
  readonly settings: Pick<CopilotSettings, "binaryPath"> | null | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: input.settings?.binaryPath || "copilot",
    args: [...copilotAcpSpawnArgs(input.runtimeMode)],
    cwd: input.cwd,
    ...(input.environment === undefined ? {} : { env: input.environment }),
  };
}

interface CopilotAcpRuntimeInput extends Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn"> {
  readonly settings: Pick<CopilotSettings, "binaryPath"> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const makeCopilotAcpRuntime = Effect.fn("CopilotAcpSupport.makeCopilotAcpRuntime")(
  function* (
    input: CopilotAcpRuntimeInput,
  ): Effect.fn.Return<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  > {
    const { settings, environment, runtimeMode, ...options } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...options,
        spawn: buildCopilotAcpSpawnInput({
          settings,
          cwd: options.cwd,
          ...(environment === undefined ? {} : { environment }),
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
        }),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  },
);

/**
 * Copilot reads these before its stored login. `GH_TOKEN` and `GITHUB_TOKEN`
 * are often classic PATs left by other tools, which Copilot rejects, so only
 * the Copilot-specific variable proves anything.
 */
const COPILOT_TOKEN_ENV = "COPILOT_GITHUB_TOKEN";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `config.json` is managed by `copilot login` and starts with `//` comment
 * lines. It holds account names only; tokens live in the OS keychain.
 */
function parseCopilotLoggedInUser(configText: string): string | undefined {
  const json = configText
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const last = parsed.lastLoggedInUser;
  if (isRecord(last) && typeof last.login === "string" && last.login.trim()) {
    return last.login.trim();
  }
  const users = Array.isArray(parsed.loggedInUsers) ? parsed.loggedInUsers : [];
  const first = users.find(
    (user): user is { login: string } =>
      isRecord(user) && typeof user.login === "string" && user.login.trim().length > 0,
  );
  return first?.login.trim();
}

export function copilotConfigPath(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  join: (...segments: ReadonlyArray<string>) => string,
): string {
  const copilotHome = environment.COPILOT_HOME?.trim();
  return join(copilotHome || join(homeDirectory, ".copilot"), "config.json");
}

/**
 * A missing login is `unknown`, not signed out: Copilot can also use a
 * keychain entry or a GitHub token this check cannot see.
 */
export function copilotAuthFromSources(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly configText: string | undefined;
}): ServerProviderAuth {
  if (input.environment[COPILOT_TOKEN_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "GitHub token" };
  }
  const login = input.configText ? parseCopilotLoggedInUser(input.configText) : undefined;
  return login
    ? { status: "authenticated", type: "oauth", label: "GitHub account", email: login }
    : { status: "unknown" };
}
