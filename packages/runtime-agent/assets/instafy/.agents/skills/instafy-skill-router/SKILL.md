---
name: instafy-skill-router
description: Decide which Instafy skill(s) to apply for a user request (browsing vs previews vs secrets, etc).
context_kind: meta
context_parent: instafy-persistent-contexts
context_children: instafy-automations, instafy-browser-automation, instafy-byoc-ai-credentials, instafy-collaboration, instafy-conversation-history, instafy-diagnostics, instafy-frontend-previews, instafy-git-canonical-conflicts, instafy-git-canonical-sync, instafy-integration-onboarding, instafy-learning-policy, instafy-location-sharing, instafy-runtime-flavors, instafy-secrets, instafy-skill-import-compat
always_include: true
max_children: 3
---

# Skill router (meta)

Never prune: yes

Goal: keep behavior consistent by selecting the right skill(s) based on the user’s request.

Treat the selected skill set as the active branch of the persistent context tree for this turn.

## How to use (strict)

1. Skim the **Skills index** in the project memory snapshot (names + descriptions).
2. Pick the smallest set of skills that apply.
3. Follow those skill runbooks. Do not invent new workflows when a relevant skill exists.

Notes:
- Do not mention “skills” to the user unless they asked.
- Prefer skill guidance over ad-hoc shell commands.
- If two skills apply, you may combine them, but keep the execution mode clear (for example: “Tunnel preview mode” vs “Live browser assist mode”).

## Learned blocks (/learn)

If the project contains `instafy-learned` (the learned blocks index):

1. Open `instafy-learned` first (it should be small).
2. If any learned block matches the user’s request, include it in your selected skills.
3. Open at most **2** learned blocks for a given user request.

Do not load learned blocks “just in case”. Only load what clearly applies.

## Routing rules (default)

Use these mappings unless a project-specific skill overrides them.

- **Interactive browsing / guided clicks / consent / login / MFA / checkout**
  - Use `instafy-browser-automation`.
  - Use the exposed Personal or Shared Browser tools. If neither is exposed, follow the skill's `request_browser` handoff so Studio can open or resume the appropriate browser.

- **Public page text / element counts / computed CSS / screenshot verification**
  - Use `instafy-browser-automation`.
  - Prefer `instafy_local_browser.observe` when it is exposed; it is headless and read-only, not an interactive or authenticated session.

- **Nearby / around me / current location / walking distance**
  - Use `instafy-location-sharing`.
  - Prefer an inline location action card over telling the user to search manually.
  - Combine with `instafy-browser-automation` only when live browsing is needed after location is shared.

- **Shareable preview URL / mobile-friendly link / “can you show me a demo link”**
  - Use `instafy-frontend-previews` (tunnel preview mode).
  - Ask for consent before creating a public URL or opening a live browser.

- **Missing env vars / API keys / OAuth client setup / dashboards**
  - Use `instafy-integration-onboarding` for the step-by-step plan.
  - Use `instafy-secrets` to request/store secrets (never write secrets to files).
  - If the user wants help clicking around dashboards, combine with `instafy-browser-automation`.

- **Git canonical syncing / conflicts**
  - Use `instafy-git-canonical-sync` for normal sync.
  - Use `instafy-git-canonical-conflicts` when sync hits conflicts.

- **Runtime flavor/image selection**
  - Use `instafy-runtime-flavors`.

- **Bring-your-own AI credentials**
  - Use `instafy-byoc-ai-credentials`.

- **Invite teammate / add collaborator / share this space by email / change teammate access**
  - Use `instafy-collaboration`.
  - Direct the user to the interactive **Invite** UI or the Studio composer `/invite <email> <viewer|builder>` command.
  - For existing-member or pending-invite changes, direct the user to **Invite → Manage access**.
  - Interpret “write access” as `builder`; project sharing only offers `viewer` and `builder`.
  - Do not run CLI sharing commands from a runtime job. Scoped runtime/tool tokens intentionally cannot manage sharing.

- **Earlier chat / other conversation / previous discussion / “we talked about this before”**
  - Use `instafy-conversation-history`.
  - Prefer normal-language lookup over teaching special composer syntax.
  - Search first with `instafy conversation search "<keywords>"`, then inspect with `instafy conversation show <id>`.

- **Failed run / runtime error / diagnose / investigate / support report**
  - Use `instafy-diagnostics`.
  - Read signed-in-user diagnostics first; never scrape local logs or use raw/operator APIs.
  - Keep diagnosis read-only unless the user explicitly asks to file a report, then preview and
    obtain confirmation before submitting once.

- **Reminders / schedules / recurring tasks / “in 10 minutes” / “every morning at 8” / automation management**
  - Use `instafy-automations`.
  - Prefer the Instafy CLI automation commands over manual UI setup.
  - Interpret times in the user's local timezone from client context unless they explicitly say otherwise.

## Ambiguous cases

- If the user asks “use a browser” but they actually want a shareable link:
  - Ask one short clarification: “Do you want a shareable public preview link, or a live browser walkthrough here?”
- If the user asks for “latest news”:
  - Default to `instafy-browser-automation` if they asked for a visible session.
  - Otherwise, you can answer without a browser, but clearly label it as “no live browsing used”.
