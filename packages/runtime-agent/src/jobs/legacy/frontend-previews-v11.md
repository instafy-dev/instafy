---
name: instafy-frontend-previews
description: Show a site or server running in this space (localhost, a dev server) to people as a private Studio preview card (instafy preview open), check it yourself (instafy preview check), keep it running after your turn, or share a public link with consent. Not for Instafy's browser.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: preview, previews, preview card, localhost, 127.0.0.1, 0.0.0.0, on port, which port, port number, dev server, local server, web server, running site, running server, static site, landing page, tunnel, shareable link, demo link, förhandsvisning, vista previa, プレビュー
---

# Previews: show a site running in this space

Use this whenever a site or server runs in this space (or should) and someone should see it: on any port, for any kind of site. `instafy preview` is a CLI command group, not a tool; run it in the shell. `instafy preview --help` lists its commands.

## What can see what

- **People in Studio** see the site through a private "Ready to preview" card: `instafy preview open`. Only space members can open it; nothing becomes public.
- **You** look at it with `instafy preview check --port <port>`: it loads the page in a headless browser here, lists console errors, failed requests and a blank page, and writes desktop and phone screenshots. Exit 4 (no browser here) or 70 (the check itself failed) means nothing was checked; say so.
- **Instafy's browser** opens public web addresses only: its safety policy blocks this space's own addresses (localhost, 127.0.0.1, 0.0.0.0, private addresses) and non-web ports. Do not try to work around it. Never send it, or a `request_browser` task, to such an address, and after "destination denied" do not retry, re-approve or request the browser again: open a preview card instead, and say why in one line. Only a public tunnel URL (below, with consent) can be opened there.

## Show it (do this first)

1. From the site's folder inside the workspace (not a temporary folder), start it and show it in one command:
   `instafy preview open --port <port> --title "<short name>" --serve-cmd "<command>" --start --json`
   (add `--path /<page>` for a sub-page). The command serves the site on 127.0.0.1 or 0.0.0.0 at that port. See "Keep it running after your turn" for what `--start` does.
   - It posts the card in this conversation and prints no URL. Tell the person to open it from the card once `instafy preview check` passes (step 2). Do not paste a preview, tunnel or localhost URL for it.
   - Running it again for the same port keeps the same preview. In the same turn it reuses that turn's card; in a later turn it posts a new card, and the person opens the newest card. It never refreshes an earlier card. `instafy preview list` lists open previews; `instafy preview close <previewId>` closes one.
2. Check it: `instafy preview check --port <port>`. Fix what it lists, then run the same `instafy preview open` again.
3. Allow the preview host before the person opens the card. Dev servers that check the `Host` header (Vite dev and `vite preview`, webpack-dev-server, Angular) show "Blocked request" to everyone who opens the card, and you cannot see that page yourself. The first time you open a preview for such a server, add `viewerHostSuffix` from the JSON, with a leading dot and without `:port`, to its allowed hosts (Vite: `server.allowedHosts` and `preview.allowedHosts`; webpack-dev-server and Angular: `allowedHosts`), stop the server by its `startedPid` (below), and run the same `instafy preview open` again before you tell the person to open the card. Static file servers need nothing.
4. Read `status`: `live` means the card works. `not_responding`: check the server is up on that port, then run `instafy preview open` again. `unknown`: tell the person to open the card. Only `status: live` from an `instafy preview open` you ran this turn shows the site is up: never say a preview is live, restarted or refreshed from anything else.
5. Read `restartable`. `true` means opening the card starts the site again after it stops or the space sleeps, with no turn: it reruns the recorded command. `false`: `restartNote` says why; run it again with `--serve-cmd "<command>"`.
6. If it fails:
   - Exit `2`: nothing answers on 127.0.0.1 at that port, the site answers with a server error, or the command `--start` ran exited or stayed silent (the message names its log: read it, fix the cause, run it again). If the message says the site answers only on [::1], do not start a second one; bind it to 127.0.0.1 or 0.0.0.0, restart it, run it again.
   - Exit `3`: the port is not allowed. Serve on another port from 1024 to 65535.
   - Exit `5` ("Previews are not available on this server"), or `instafy preview` is not a command here: previews are off. Post the local URL; create a public tunnel only when the person asks for a shareable link, after consent.
   - Exit `1` (any other error): run it once more. If it fails again, give the error in one line and post the local URL. No public tunnel unless asked.
7. If the person reports "Blocked request" or "host is not allowed" on the card's page, do step 3 for that server.

## Keep it running after your turn

Every process your turn starts is killed with its terminal's process group when the turn ends. A server started in the foreground or with `&` is gone by the next message, and the card goes dark.

- Start a site that must outlive the turn with `instafy preview open --port <port> --title "<name>" --serve-cmd "<command>" --start --json`, run from the site's folder. It starts the command in its own session without Instafy credentials, logs to `.instafy/agent/logs`, waits for the port, posts the card, and returns `startedPid` and `logFile` (`startedPid` is null when the port already answered and nothing was started).
- `--serve-cmd` is one command and its arguments: no shell syntax, and no secret on the line (the site reads secrets from an env file). A command that needs shell syntax (environment assignments, `cd`, a pipeline) goes in a script file in the site's folder, passed as `--serve-cmd "sh ./serve.sh"`.
- Do not start a site that must outlive the turn with `&`, `nohup` or `setsid` by hand: it keeps this turn's credentials.
- In a later turn, check the port first (`curl -fsS http://127.0.0.1:<port>/ > /dev/null`). If it is not running, rerun the same command; it keeps the preview and posts this turn's card. Do not start a second server on another port for the same site.
- When the space's machine stops or restarts, its sites stop: their cards read Stopped and `instafy preview list` no longer lists them. That is expected. Open on a `restartable` card starts the site again with no turn, so tell the person to press it; or rerun the same `instafy preview open ... --start` and read its `status`.
- When a start fails, read `logFile` before trying again.
- Stop a site by its `startedPid`: it leads its own process group, so `kill -- -<startedPid>` stops it and its children. Never stop one by a name pattern.
- If the site has a `bound.json`, `instafy bind serve --detach` already does this.

## Building a site to show

- Don't assume a framework. Inspect the workspace (`package.json`, `vite.config.*`, `next.config.*`, etc) and use its own dev or preview command with an explicit port (Vite often `5173`, Next `3000`) and a reachable host (`--host 0.0.0.0` or `127.0.0.1`).
- With no toolchain, prefer one `index.html` (React through ESM CDN imports such as `https://esm.sh/react@18` if needed) served by a static file server, for example `--serve-cmd "python3 -m http.server 4173 --bind 127.0.0.1"`.
- Install dependencies only when needed, and say you did.
- Prefer stable, explicit ports. Reuse a healthy server instead of starting a duplicate.
- Never store secrets in the workspace. Request them with `request_secret` actions; if a provider's screens are involved, open Instafy's browser on the provider's public site to show the way.
- If this is a git repo, make sure `.gitignore` excludes `.instafy/agent/`.
- A site that uses the person's location, or that people will Present and Follow together in Studio: read `references/studio-host-messages.md` before writing that code.

## Public links (tunnel mode, consent first)

Only when the person wants a shareable, public or phone link, or previews are not available:

- Never auto-create a public tunnel URL. Ask for explicit consent first. Say that anyone with the link can open it. If they decline, stop at the card or the local URL.
- Then `instafy tunnel start --port <port> --json` (parse `url`, `tunnelId`, `localPort`, `pid`), and post the URL as a normal link. `instafy tunnel list`, `instafy tunnel logs <tunnelId> --follow` and `instafy tunnel stop <tunnelId>` manage it.
- A tunneled site is a new website origin: backends on localhost, auth callback allowlists and Host-checking dev servers need changes. Read `references/tunnels.md` for those, the controller API flow and what to do when tunnels are unavailable.

## "I can't reach the preview" (preview doctor)

- Does the port answer (`curl -fsS http://127.0.0.1:<port>/`)? If not, read the site's log and run the same `instafy preview open ... --start` again.
- `instafy preview list` lists open previews: its status says the preview is open, not that the site answers, and a stopped preview is not listed. Rerunning the same `instafy preview open ... --start` starts the site when needed and posts this turn's card; read its `status`.
- Run `instafy preview check --port <port>` for page errors (framework config, base paths, env vars).
- For a tunnel, see `references/tunnels.md`.

Report what each command returned (exit code, `status`), not what you expect a card to show.

## Cleanup

When asked to stop previews: stop the site by its `startedPid` (never by a name pattern), close the card's preview (`instafy preview close <previewId>`) and stop any tunnel.
