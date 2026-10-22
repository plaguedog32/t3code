import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { CopilotSettings } from "../settings.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copilotTotals(usage: Record<string, unknown>): UsageTokenTotals {
  const cachedInputTokens = tokenCount(usage["cacheReadTokens"]);
  const cacheCreationTokens = tokenCount(usage["cacheWriteTokens"]);
  const outputTokens = tokenCount(usage["outputTokens"]);
  return {
    // Copilot's `inputTokens` includes both cache reads and cache writes.
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage["inputTokens"]) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage["reasoningTokens"])),
  };
}

/**
 * One `session.usage_record` event is written per model call. Its `cost` is a
 * premium-request multiplier and `copilotUsage` is in AI credits, neither of
 * which is USD, so cost comes from model pricing instead.
 */
function parseCopilotRecord(parsed: unknown): readonly UsageRecord[] {
  if (!isRecord(parsed) || parsed["type"] !== "session.usage_record") return [];
  const data = parsed["data"];
  const usage = isRecord(data) ? data["usage"] : undefined;
  if (!isRecord(usage)) return [];
  const model = typeof usage["model"] === "string" ? usage["model"].trim() : "";
  const timestampMs = parseTimestampMs(parsed["timestamp"]);
  if (!model || timestampMs === null) return [];
  const totals = copilotTotals(usage);
  if (totalTokens(totals) === 0) return [];
  const accounting = usage["accounting"];
  const sessionId =
    isRecord(accounting) && typeof accounting["sourceSessionId"] === "string"
      ? accounting["sourceSessionId"]
      : "";
  const id = typeof parsed["id"] === "string" && parsed["id"] ? parsed["id"] : null;
  return [
    {
      provider: "copilot",
      timestampMs,
      model,
      sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: id === null ? null : `copilot:${id}`,
    },
  ];
}

export function parseCopilotLine(line: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseCopilotRecord(parsed);
}

const copilotUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: {
      usage: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        accounting: { sourceSessionId: true },
      },
    },
  },
  usageMarkers: ['"session.usage_record"'],
  parseLine: (line) => parseCopilotLine(line),
  parseProjected: (projected) => parseCopilotRecord(projected),
};

export const copilotUsageReader: ProviderUsageReader<CopilotSettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const home = expandHomePath(
      environment.COPILOT_HOME?.trim() || path.join(homeDirectory, ".copilot"),
      homeDirectory,
    );
    return [{ dir: path.resolve(home, "session-state"), fileName: "events.jsonl" }];
  }),
};
