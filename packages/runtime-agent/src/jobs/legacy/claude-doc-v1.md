@AGENTS.md
@INSTAFY.md

# Claude-specific notes

`AGENTS.md` is shared with Instafy's own runtime agent, which has a different tool surface from
yours. These notes override `AGENTS.md` where the two differ.

## Instafy runtime tools that work differently here

- **`exec`, `write_stdin`, `session_id`.** That is Instafy's runtime protocol for a command that is
  still running. You have no equivalent. Run commands with your own shell tool, and before you
  reply or use what a command makes, wait for it to finish. When one needs to outlive the call,
  start it in the background and read its output rather than writing to a session id.
- **`instafy preview open … --start`.** `AGENTS.md` starts servers with it. Outside an Instafy job
  it opens a private Instafy preview, with a tunnel and a card in Studio, and needs a login and a
  conversation. Start a server in the background with your own shell instead, and do not open an
  Instafy preview unless the person asks for one.
- **`instafy web search`.** It answers only inside an Instafy job, which this session is not. Find
  links with your own search, then read the pages with `instafy web read <address>`, as
  `AGENTS.md` says.

## Skills are not in your memory path

This workspace keeps its procedures in `.agents/skills/*/SKILL.md`, and nothing under `.agents/`
is loaded into your context automatically. When a task touches a workspace convention, read the
relevant `SKILL.md` directly before acting, the same way you would read any other file.

## Replies

The Replies section of `AGENTS.md` is written for Instafy's chat. When you work on code with the
person, name the files you change and the commands you run.

## Reaching the workspace itself

The space's conversations, agents and run diagnostics are not on disk. Instafy's Claude Code
plugin gives you tools for them. Installing it changes the person's Claude Code settings, so
suggest that they run these commands rather than running them yourself:

```
claude plugin marketplace add instafy-dev/instafy --sparse .claude-plugin claude-plugin
claude plugin install instafy@instafy
```

It needs an `instafy` CLI that has `instafy mcp` on the person's `PATH` and a session from
`instafy login`, and its tools act as the signed-in person. The `instafy conversation` and
`instafy diagnostics` commands the skills name also work from your shell while the person is
signed in; pass `--space <id>` when the folder is not linked to a space.
