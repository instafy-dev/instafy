# @instafy/cli

## 0.2.3

### Patch Changes

- 7e3b932: Add customer commands for reading paginated support case timelines and posting idempotent follow-up replies.

## 0.2.2

### Patch Changes

- 67ff0e4: Allow ordinary `instafy chat` prompts to persist requested workspace files, matching Studio chat behavior.

## 0.2.1

### Patch Changes

- 46b2a0a: Automations can now share their result threads with the team. `instafy automations create` and `instafy automations update <automation-id>` gain `--share-results`, `--no-share-results`, and `--result-visibility <private|team>`, so the setting can be chosen at creation or flipped on an existing automation. The result visibility (`private` by default, `team` when shared) is shown in `automations list` and `--json` output. "Team" means visible to anyone with access to the space; results stay private unless you opt in.
- f6d5396: Add `instafy automations update <automation-id>` to change an automation's name, prompt (`--prompt` or `--prompt-file`), schedule, timezone, runtime mode and provider, and quiet-run setting in place. The automation keeps its id, private conversation, and run history, and its next run only moves when the schedule changes.
- f952ac7: Add `instafy credentials list | test | default | revoke` so you can see which AI provider credentials your account holds, verify one against its upstream provider through the proxy, pick or clear the default that jobs use, and revoke a credential. Commands accept a full id or a unique id prefix, support `--json`, and never print secret material.
- a103d6b: Default the hosted Studio URL used by `instafy login` and Studio links to `https://instafy.dev`; the retired `staging.instafy.dev` host has no infrastructure behind it.
- 9171ac6: Jobs and agents that do not pin an OpenAI model now default to `gpt-5.6-sol` on the hosted runtime (previously `gpt-5.5`). The new default takes effect on the next hosted deploy; explicitly selected models, including `gpt-5.5`, are unaffected.
- 8ded305: Add `instafy team` commands for managing team membership and invitations: `members` lists a
  team's people, `invite` sends an email invitation, `invite-link` creates a shareable join link,
  `invites` lists what is pending, `add-member` adds an existing account by user id, `accept` joins
  from a token, and `revoke-invite` / `revoke-link` remove pending invitations and links. The team
  is resolved from `--team-id <uuid|slug>` and falls back to your only team when you belong to one.

## 0.2.0

### Minor Changes

- 18d7ba6: Separate the customer CLI from hosted operator tooling, add signed-in-user diagnostics and
  owner-only support commands, and remove the legacy public operator, raw API, OTA, and Desktop
  update command groups. This is a breaking pre-1.0 release.
