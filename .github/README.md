# T3 Code (plaguedog32 fork)

This is a fork of [T3 Code](https://github.com/pingdotgg/t3code), the "agent harness control surface". It adds GitHub Copilot as a provider and takes out everything that phones home. Everything else is upstream T3 Code, kept as close to it as possible so new releases merge in cleanly.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and now **GitHub Copilot**. If they're set up on your computer, T3 Code can control them.

The fork's changes live on the [`fork/copilot-provider`](https://github.com/plaguedog32/t3code/tree/fork/copilot-provider) branch.

## What's different

### GitHub Copilot, as a first-class provider

Copilot sits next to Codex and Claude instead of going through the generic ACP registry.

- Runs the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) in ACP mode, so threads use your Copilot subscription, models, MCP servers, custom instructions, and agents.
- Picks up your account's full model list from Copilot, with **Auto** to let Copilot choose.
- Supports Supervised, Auto-accept edits, and Full access permission modes.
- **Usage** shows token history from Copilot's session logs, next to your other providers.
- **Usage → Limits** shows your monthly premium requests, chat, and code completions, and your plan. Quotas your plan doesn't include show as **none included** instead of disappearing.

Full details: [GitHub Copilot docs](../docs/user/providers-copilot.md).

### Nothing phones home

Telemetry and T3 Connect are switched off in the code itself, in [`packages/shared/src/forkPolicy.ts`](../packages/shared/src/forkPolicy.ts). No environment variable or build key turns them back on.

| Disabled              | What that means                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Usage analytics       | The server never sends events to T3 Code's PostHog (`ingest.t3.codes`), even with `T3CODE_TELEMETRY_ENABLED=true`.                     |
| Relay tracing         | The server, desktop, web, and mobile apps never send connection traces to T3 Code's Axiom.                                             |
| T3 Connect            | No tunnel, no relay, no `t3 connect`. Sign-in, Connect onboarding, and **Connections → T3 Connect** are hidden, and Clerk never loads. |
| Mobile cloud features | The mobile app has no sign-in, relay environments, or push notification registration.                                                  |

What still works, and still reaches the internet:

- Connecting directly over your local network or Tailscale. See [remote access](../docs/user/remote-access.md).
- Your own OpenTelemetry export, which only sends to an address you set.
- Desktop update checks. Set `T3CODE_DISABLE_AUTO_UPDATE=1` to turn them off.
- Agent CLI version checks. Turn them off in Settings.
- The agents themselves, which talk to their own providers.

## Installation

The upstream installers, package registries, and releases ship upstream T3 Code, without these changes. Run this fork from source.

> [!WARNING]
> Install and authenticate at least one provider before use:
>
> - GitHub Copilot: install [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) and run `copilot login`. For **Usage → Limits**, also sign in to the [GitHub CLI](https://cli.github.com) with `gh auth login`, or set `COPILOT_GITHUB_TOKEN`.
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Install `vp`

T3 Code uses Vite+ so you'll need the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

### Clone and run

```bash
git clone -b fork/copilot-provider https://github.com/plaguedog32/t3code.git
cd t3code
vp i
```

Then start the desktop app:

```bash
vp run dev:desktop
```

Or just the server and web app:

```bash
vp run dev
```

## Staying up to date

The fork follows upstream. To pull in new T3 Code releases:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream
git rebase upstream/main
```

## Some notes

This is a personal fork. Expect bugs, on top of upstream's.

Problems with Copilot or the disabled features belong here. Everything else is probably upstream's, so check [their issues](https://github.com/pingdotgg/t3code/issues) first. Please don't take fork-only bugs to the T3 Code team.

## Documentation

Full docs live in [docs/](../docs). Upstream's docs still describe telemetry and T3 Connect as upstream ships them, which doesn't apply here.

- [GitHub Copilot](../docs/user/providers-copilot.md)
- [Usage and limits](../docs/user/usage.md)
- [Install and first run](../docs/user/install.md)
- [Permission modes](../docs/user/permission-modes.md)
- [Remote access from a phone or another machine](../docs/user/remote-access.md)
- [Keyboard shortcuts](../docs/user/keybindings.md)

The original README is [here](../README.md).
