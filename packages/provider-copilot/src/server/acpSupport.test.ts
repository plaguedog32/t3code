import { describe, expect, it } from "vite-plus/test";

import { copilotAcpSpawnArgs, copilotAuthFromSources } from "./acpSupport.ts";

// Shape written by `copilot login` (CLI 1.0.101): comment header, accounts only.
const LOGGED_IN_CONFIG = `// User settings belong in settings.json.
// This file is managed automatically.
{
  "firstLaunchAt": "2026-07-18T19:32:52.615Z",
  "loggedInUsers": [{ "host": "https://github.com", "login": "octocat", "kind": "githubDotCom" }],
  "lastLoggedInUser": { "host": "https://github.com", "login": "octocat" }
}
`;

describe("copilotAcpSpawnArgs", () => {
  it("grants only what each runtime mode allows", () => {
    expect(copilotAcpSpawnArgs("approval-required")).toEqual(["--acp", "--no-auto-update"]);
    expect(copilotAcpSpawnArgs("auto-accept-edits")).toEqual([
      "--acp",
      "--no-auto-update",
      "--allow-tool=write",
    ]);
    expect(copilotAcpSpawnArgs("full-access")).toEqual([
      "--acp",
      "--no-auto-update",
      "--allow-all",
    ]);
    // T3 cannot back Auto with a Copilot classifier, so it launches asking.
    expect(copilotAcpSpawnArgs("auto")).toEqual(["--acp", "--no-auto-update"]);
  });
});

describe("copilotAuthFromSources", () => {
  it("reads the stored login account", () => {
    expect(copilotAuthFromSources({ environment: {}, configText: LOGGED_IN_CONFIG })).toEqual({
      status: "authenticated",
      type: "oauth",
      label: "GitHub account",
      email: "octocat",
    });
  });

  it("prefers the Copilot token variable", () => {
    expect(
      copilotAuthFromSources({
        environment: { COPILOT_GITHUB_TOKEN: "github_pat_x" },
        configText: undefined,
      }).type,
    ).toBe("api_key");
  });

  it("reports unknown, not signed out, when nothing proves a login", () => {
    for (const configText of [undefined, "", "// header\n{}", "not json"]) {
      expect(
        copilotAuthFromSources({ environment: { GH_TOKEN: "ghp_classic" }, configText }),
      ).toEqual({ status: "unknown" });
    }
  });
});
