# GitHub Copilot

T3 Code runs the GitHub Copilot CLI on the machine that hosts the T3 Code server. Threads use your
Copilot subscription, models, MCP servers, custom instructions, and agents.

## Set up Copilot

1. Install the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) on the
   server machine. T3 Code supports version 1.0.101 or newer.
2. Run `copilot login` in a terminal on that machine. On a headless server, use
   `copilot login --device-code`, or set `COPILOT_GITHUB_TOKEN` to a fine-grained token with the
   **Copilot Requests** permission in the instance's environment variables.
3. Open T3 Code **Settings → Providers**, enable GitHub Copilot, and refresh it.

If `copilot` is not on the server's `PATH`, set the binary path to the executable.

## Models

**Auto** lets Copilot pick a model. Your account's full model list appears after the first
Copilot thread starts a session, because Copilot reports it only inside a session. Add other
model IDs, such as your own provider's models, as custom models in the instance settings.

## Permission modes

- **Supervised** asks before commands, file changes, and other tools Copilot does not allow by
  default.
- **Auto-accept edits** allows file edits and asks before commands and other tools.
- **Full access** allows all tools, paths, and URLs.

Copilot has no automatic review, so a thread set to **Auto** runs in **Supervised**. Changing the
mode restarts the Copilot process for that thread.

## Usage and limits

**Usage** reads token use from Copilot's session history in `~/.copilot/session-state`, or under
`COPILOT_HOME` when set. Copilot bills in premium requests or AI credits rather than dollars, so
costs are estimates from model prices; set a price under **Model prices** for models without one.

**Usage → Limits** shows your monthly premium requests, chat, and code completions. Quotas your plan
does not include show as **none included**. T3 Code reads them with `COPILOT_GITHUB_TOKEN` when
set, otherwise with the GitHub CLI's login, so run `gh auth login` as the same account Copilot uses.
Limits stay hidden when the GitHub CLI is signed in to a different account.

## Updates

T3 Code updates Copilot only when npm installed it. For WinGet, Homebrew, or the install script,
update through that installer or run `copilot update`.

Copilot set up earlier through the [ACP Registry](./providers-acp.md) keeps working. You can
remove that instance once the GitHub Copilot provider is enabled.
