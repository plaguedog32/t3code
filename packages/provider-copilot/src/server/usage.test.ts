import { describe, expect, it } from "vite-plus/test";

import { parseCopilotLine } from "./usage.ts";

const usageRecord = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "session.usage_record",
    data: { usage },
    id: "b6874ba5-6a7d-4a2f-a1d7-4e0e027483d7",
    timestamp: "2026-10-21T23:07:40.065Z",
    ...extra,
  });

describe("parseCopilotLine", () => {
  it("splits cache reads and writes out of Copilot's inclusive input count", () => {
    const [record] = parseCopilotLine(
      usageRecord({
        model: "gpt-6-luna",
        inputTokens: 15_539,
        outputTokens: 124,
        cacheReadTokens: 7_721,
        cacheWriteTokens: 7_815,
        reasoningTokens: 103,
        cost: 1,
        accounting: { sourceSessionId: "session-1" },
      }),
    );
    expect(record).toEqual({
      provider: "copilot",
      timestampMs: Date.parse("2026-10-21T23:07:40.065Z"),
      model: "gpt-6-luna",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 3,
        cachedInputTokens: 7_721,
        cacheCreationTokens: 7_815,
        outputTokens: 124,
        reasoningTokens: 103,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "copilot:b6874ba5-6a7d-4a2f-a1d7-4e0e027483d7",
    });
  });

  it("ignores other events, empty usage, and records without a model or time", () => {
    expect(parseCopilotLine(JSON.stringify({ type: "assistant.message", data: {} }))).toEqual([]);
    expect(parseCopilotLine(usageRecord({ model: "gpt-6-luna" }))).toEqual([]);
    expect(parseCopilotLine(usageRecord({ inputTokens: 10 }))).toEqual([]);
    expect(
      parseCopilotLine(usageRecord({ model: "gpt-6-luna", inputTokens: 10 }, { timestamp: 5 })),
    ).toEqual([]);
    expect(parseCopilotLine("not json")).toEqual([]);
  });

  it("caps reasoning at the output it is part of", () => {
    const [record] = parseCopilotLine(
      usageRecord({ model: "auto-picked", inputTokens: 10, outputTokens: 4, reasoningTokens: 9 }),
    );
    expect(record?.totals.reasoningTokens).toBe(4);
    expect(record?.sessionId).toBe("");
  });
});
