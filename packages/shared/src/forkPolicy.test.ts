import { describe, expect, it, vi } from "vite-plus/test";

describe("forkPolicy", () => {
  it("keeps telemetry and T3 Connect off in shipped code", async () => {
    const actual = await vi.importActual<typeof import("./forkPolicy.ts")>("./forkPolicy.ts");
    expect(actual.TELEMETRY_ENABLED).toBe(false);
    expect(actual.T3_CONNECT_ENABLED).toBe(false);
  });
});
