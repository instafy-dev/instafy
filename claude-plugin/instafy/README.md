# Instafy plugin for Claude Code

Work with an Instafy space from your own Claude Code: read its conversations and message history,
your agents and their context notes, and its run diagnostics.

Claude Code runs on your machine, under your own Claude plan or API key, in Anthropic's own client.
Instafy provides tools: it issues no model request, holds no Anthropic credential, and cannot start a
turn.

Separately, Instafy Desktop can run your own Claude Code for one message you choose in an Instafy
chat ([local-engine turns](../../docs/Local-Engine-Turns.md)). If you installed the plugin, its skill
is available in such a turn, as in your own sessions, but its tools are not, and they still cannot
start a turn.

## Install

You need an Instafy CLI that has `instafy mcp` on your `PATH`, and a signed-in session:

```bash
npm install -g @instafy/cli@latest
instafy login
instafy mcp --help
```

The last command prints usage that begins `Usage: instafy mcp`. If it prints the CLI's general help,
which begins `Usage: instafy [options] [command]`, the `instafy` on your `PATH` is older than
`instafy mcp`.

Then add the marketplace and install the plugin from a shell. `--sparse` limits the checkout to the
plugin's files and fetches no submodule; without it, the Instafy repository's large submodule can run
past the clone timeout:

```bash
claude plugin marketplace add instafy-dev/instafy --sparse .claude-plugin claude-plugin
claude plugin install instafy@instafy
```

In Claude Code 2.1.295 or later you can do both from a terminal session instead, with
`/plugin install instafy --marketplace instafy-dev/instafy`.

A session that was already running picks the plugin up after `/reload-plugins` in a terminal session
(add `--force` if it asks). In the desktop app, start a new session.

To work from a checkout, add the marketplace from its directory:

```bash
claude plugin marketplace add ./path/to/instafy
```

Claude Code then reads the plugin's skill and server entry from that checkout. The server it starts is
still the `instafy` on your `PATH`.

## What it adds

A `workspace` skill, and an MCP server, `instafy mcp`, with these tools:

| Tool | Reads or writes |
| - | - |
| `list_spaces`, `list_teams` | read |
| `list_conversations`, `search_conversations`, `grep_messages` | read |
| `show_conversation`, `message_context` | read |
| `create_conversation` | write: a conversation everyone in the space can see |
| `list_agents` | read; the first call creates your default `@octo` agent if you have none |
| `read_agent_settings`, `list_agent_context` | read |
| `put_agent_context` | write: replaces the agent's note for that scope |
| `agent_run_status`, `runtime_events`, `run_result` | read |

Claude Code names each one `mcp__plugin_instafy_instafy__<tool>`, for example
`mcp__plugin_instafy_instafy__grep_messages`. Use that full form in a permission rule, and run `/mcp`
to see the server's status.

To use the server without the plugin, register `instafy mcp` as a stdio server under a name of your
own. In Claude Code, that name cannot be one it reserves for a built-in server, such as `workspace`.

```bash
claude mcp add instafy -- instafy mcp
```

## How it works

`instafy mcp` serves MCP over stdin and stdout. Claude Code starts it; you do not run it by hand.

Each tool call runs the `instafy` CLI as a child process and returns its JSON. That isolation is
deliberate: the command layer prints to stdout and exits the process on failure, and a child's stdout
and exit code cannot reach the protocol stream or end the server.

Every call runs as you, on a session `instafy login` saved: the one for the profile that
`INSTAFY_PROFILE` or the nearest `.instafy/space.json` selects (`instafy login --profile <name>` saves
it), or else the default one. A repository you clone can commit a `.instafy/space.json` that selects
one of your other saved profiles, so check that file if results come from an account you did not
expect. Tools take no access token or server. Access tokens, server URLs and space ids set in the
environment are ignored, and a call is refused, without sending anything, when no session is saved or
when `HOME` is not an absolute path.

A tool that is given no space uses the one the working directory is bound to with
`instafy space init`, if it is bound. The two write tools always name their space.

Results are capped at about 36,000 characters, and a result that had to be cut says what it left out.
A list keeps whole entries. A cut `show_conversation` page keeps a cursor that goes on from the last
message shown; a cut `grep_messages` page drops its cursor, so ask again with a smaller `limit`.
`message_context` keeps the messages nearest the one asked for. An entry too long for one result keeps
its own text whole while its other long texts are cut short and, if that is not enough, its bulkiest
parts are left out, each with a marker; its text is cut only when it alone is too long. For an agent's
reply, `run_result` reads the run it came from, with the reply's full text and run log; other cut
parts cannot be read through these tools. A long run result comes back in pages.

Up to four calls run at once. Each call is stopped 60 seconds after it arrives, its wait for a turn
included; `INSTAFY_MCP_CALL_TIMEOUT_MS` changes that. A write that ends without a definite answer,
such as on a timeout or a dropped connection, says that the change may or may not have been made.

## What it does not do

It does not read or write files and does not run commands: Claude Code's own tools do that better,
and the project directory is already open. It does not start Instafy agent runs, and it does not
expose secrets, provider credentials, previews, tunnels or runtimes.

## Troubleshooting

**The tools do not appear.** Run `/mcp`. If `plugin:instafy:instafy` is not listed, the plugin is not
loaded yet: run `/reload-plugins`, or start a new session. If it is listed as failed, the `instafy`
it starts is missing, or too old to have `instafy mcp`, on the `PATH` Claude Code was launched with.
Fix that, then select the server in `/mcp` and choose Reconnect. If the fix changed your `PATH`,
restart Claude Code from a shell where `instafy mcp --help` prints `Usage: instafy mcp`, and choose
Reconnect in the new session as well: for 15 minutes after a plugin's server fails, a new session
lists it as failed without starting it.

**Every call says to sign in.** Run the command the error names in a terminal, then retry. That is
`instafy login`, or `instafy login --profile <name>` when `INSTAFY_PROFILE` or the folder's
`.instafy/space.json` selects a profile: plain `instafy login` saves the profile that its own
terminal and folder select, which may not be the one Claude Code uses. A
session created with `instafy login --token` cannot refresh itself and will start failing once it
expires; sign in through the browser flow for a session that renews.

**A call says access was denied.** The signed-in account is not allowed to do that; the error's
Server line, if it has one, says why. Signing in again helps only if you meant to use another
account.

**A write says it may or may not have been made.** It ended without a definite answer, so check
`list_conversations` or `list_agent_context` before making it again.

**A result was cut.** Follow `nextCursor` where the result still has one. For `message_context`, call
again with `message` set to `olderCursor` and `after` 0, or to `newerCursor` and `before` 0. For
`run_result`, call again with the `offset` the result names. Otherwise ask again with a smaller
`limit`, except for `search_conversations`, whose `limit` sets how far back it searches.
