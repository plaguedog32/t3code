import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

/**
 * Copilot's own clients read quotas here. It is not a documented API, so a
 * failed or unexpected reply only marks limits unreadable.
 */
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

const QuotaSnapshot = Schema.Struct({
  entitlement: Schema.optional(Schema.Number),
  percent_remaining: Schema.optional(Schema.Number),
  unlimited: Schema.optional(Schema.Boolean),
});

const CopilotUserResponse = Schema.Struct({
  login: Schema.optional(Schema.String),
  access_type_sku: Schema.optional(Schema.String),
  copilot_plan: Schema.optional(Schema.String),
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(Schema.Record(Schema.String, QuotaSnapshot)),
});
type CopilotUserResponse = typeof CopilotUserResponse.Type;

/**
 * Completions are an editor quota the CLI never spends; it is listed so the
 * page shows the whole plan.
 */
const QUOTA_WINDOWS = [
  { id: "premium_interactions", label: "Premium requests" },
  { id: "chat", label: "Chat" },
  { id: "completions", label: "Code completions" },
] as const;

/** The allowance refills monthly, so its window is the month before the reset. */
function monthlyWindowMinutes(reset: DateTime.Utc): number {
  const start = DateTime.subtract(reset, { months: 1 });
  return Math.round((DateTime.toEpochMillis(reset) - DateTime.toEpochMillis(start)) / 60_000);
}

export function copilotPlanLabel(response: CopilotUserResponse): string | undefined {
  if (response.access_type_sku?.includes("free")) return "Copilot Free";
  switch (response.copilot_plan) {
    case "business":
      return "Copilot Business";
    case "enterprise":
      return "Copilot Enterprise";
    default:
      return undefined;
  }
}

export function copilotQuotaToLimits(
  response: CopilotUserResponse,
  checkedAt: string,
): ServerProviderUsageLimits {
  const reset = response.quota_reset_date_utc
    ? DateTime.make(response.quota_reset_date_utc)
    : Option.none();
  const windows: ServerProviderUsageWindow[] = [];
  for (const quota of QUOTA_WINDOWS) {
    const snapshot = response.quota_snapshots?.[quota.id];
    if (!snapshot) continue;
    // Plans report a quota they lack as a zero entitlement. Neither it nor an
    // unlimited quota has a pace, so both omit reset timing.
    if (snapshot.unlimited === true) {
      windows.push({
        id: quota.id,
        kind: "monthly",
        label: `${quota.label} · unlimited`,
        usedPercent: 0,
      });
      continue;
    }
    if (snapshot.entitlement !== undefined && snapshot.entitlement <= 0) {
      windows.push({
        id: quota.id,
        kind: "monthly",
        label: `${quota.label} · none included`,
        usedPercent: 100,
      });
      continue;
    }
    if (snapshot.percent_remaining === undefined) continue;
    windows.push({
      id: quota.id,
      kind: "monthly",
      label: quota.label,
      usedPercent: clampPercent(100 - snapshot.percent_remaining),
      ...(Option.isSome(reset)
        ? {
            resetsAt: DateTime.formatIso(reset.value),
            windowDurationMins: monthlyWindowMinutes(reset.value),
          }
        : {}),
    });
  }
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "GitHub reported no Copilot quotas.",
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

/**
 * Copilot keeps its own token in the OS credential store, which differs on
 * every platform. `COPILOT_GITHUB_TOKEN` or the GitHub CLI's login reach the
 * same account on all of them.
 */
const readGitHubToken = Effect.fn("readCopilotGitHubToken")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const explicit = environment.COPILOT_GITHUB_TOKEN?.trim();
  if (explicit) return explicit;
  const args = ["auth", "token", "--hostname", "github.com"];
  const spawn = yield* resolveSpawnCommand("gh", args, { env: environment });
  const result = yield* spawnAndCollect(
    "gh",
    ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
  );
  const token = result.stdout.trim();
  return result.code === 0 && token ? token : undefined;
});

export const readCopilotAccount = Effect.fn("readCopilotAccount")(function* (
  environment: NodeJS.ProcessEnv,
  copilotLogin: string | undefined,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unreadable = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });
  const token = yield* readGitHubToken(environment).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  if (!token) {
    return {
      plan: undefined,
      usageLimits: unreadable("Sign in to the GitHub CLI with `gh auth login` to show limits."),
    };
  }
  const response = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const reply = yield* client.execute(
      HttpClientRequest.get(COPILOT_USER_URL).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("User-Agent", "t3code"),
      ),
    );
    return yield* HttpClientResponse.schemaBodyJson(CopilotUserResponse)(
      yield* HttpClientResponse.filterStatusOk(reply),
    );
  }).pipe(Effect.timeout("10 seconds"), Effect.option);
  if (Option.isNone(response)) {
    return { plan: undefined, usageLimits: unreadable("GitHub did not return Copilot limits.") };
  }
  // The GitHub CLI can be signed in to a different account than Copilot.
  const login = response.value.login?.trim();
  if (copilotLogin && login && login.toLowerCase() !== copilotLogin.toLowerCase()) {
    return {
      plan: undefined,
      usageLimits: unreadable(
        `The GitHub CLI is signed in as ${login}, not ${copilotLogin}. Limits are hidden.`,
      ),
    };
  }
  return {
    plan: copilotPlanLabel(response.value),
    usageLimits: copilotQuotaToLimits(response.value, checkedAt),
  };
});
