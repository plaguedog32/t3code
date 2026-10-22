import { describe, expect, it } from "vite-plus/test";

import { copilotPlanLabel, copilotQuotaToLimits } from "./usageLimits.ts";

const CHECKED_AT = "2026-10-21T23:42:21.000Z";

const quota = (entitlement: number, percentRemaining: number, unlimited = false) => ({
  entitlement,
  percent_remaining: percentRemaining,
  unlimited,
});

describe("copilotQuotaToLimits", () => {
  it("reports each limited quota as a monthly window ending at the reset", () => {
    const limits = copilotQuotaToLimits(
      {
        quota_reset_date_utc: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          chat: quota(200, 99.5),
          completions: quota(2000, 100),
          premium_interactions: quota(300, 40),
        },
      },
      CHECKED_AT,
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "chat",
        kind: "monthly",
        label: "Chat",
        usedPercent: 0.5,
        resetsAt: "2026-11-01T00:00:00.000Z",
        windowDurationMins: 31 * 24 * 60,
      },
      {
        id: "completions",
        kind: "monthly",
        label: "Code completions",
        usedPercent: 0,
        resetsAt: "2026-11-01T00:00:00.000Z",
        windowDurationMins: 31 * 24 * 60,
      },
      {
        id: "premium_interactions",
        kind: "monthly",
        label: "Premium requests",
        usedPercent: 60,
        resetsAt: "2026-11-01T00:00:00.000Z",
        windowDurationMins: 31 * 24 * 60,
      },
    ]);
  });

  it("labels quotas a plan lacks or does not limit, without a pace", () => {
    const limits = copilotQuotaToLimits(
      {
        quota_reset_date_utc: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          chat: quota(0, 100, true),
          premium_interactions: quota(0, 0),
        },
      },
      CHECKED_AT,
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      { id: "chat", kind: "monthly", label: "Chat · unlimited", usedPercent: 0 },
      {
        id: "premium_interactions",
        kind: "monthly",
        label: "Premium requests · none included",
        usedPercent: 100,
      },
    ]);
  });

  it("marks limits unavailable when GitHub reports no quotas", () => {
    const limits = copilotQuotaToLimits({}, CHECKED_AT);
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("unsupported");
  });

  it("keeps a window without reset details when GitHub omits the reset date", () => {
    const limits = copilotQuotaToLimits(
      { quota_snapshots: { premium_interactions: quota(300, 100) } },
      CHECKED_AT,
    );
    expect(limits.windows).toEqual([
      { id: "premium_interactions", kind: "monthly", label: "Premium requests", usedPercent: 0 },
    ]);
  });
});

describe("copilotPlanLabel", () => {
  it("names plans it can identify and leaves others alone", () => {
    expect(copilotPlanLabel({ access_type_sku: "free_limited_copilot" })).toBe("Copilot Free");
    expect(copilotPlanLabel({ copilot_plan: "business" })).toBe("Copilot Business");
    expect(copilotPlanLabel({ copilot_plan: "individual" })).toBeUndefined();
  });
});
