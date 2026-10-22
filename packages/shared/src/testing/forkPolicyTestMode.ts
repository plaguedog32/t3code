import { vi } from "vite-plus/test";

// Upstream's tests exercise Connect and telemetry as upstream ships them. The
// fork's switches stay off in every build; `forkPolicy.test.ts` checks that.
vi.mock("../forkPolicy.ts", () => ({ TELEMETRY_ENABLED: true, T3_CONNECT_ENABLED: true }));
