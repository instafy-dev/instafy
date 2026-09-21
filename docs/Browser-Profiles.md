# Browser profiles and login continuity

A browser's **profile** owns its cookies and site data. Its **runtime** is where
the page executes. Its **viewer** is how you see and control that page. These are
different choices: a native Desktop window can display a remote Shared Browser,
and Personal Browser uses a runtime-agent that runs locally on your device.

## Choose the profile, not just the viewing device

| Profile | Page execution | Who shares its login state? |
| --- | --- | --- |
| **This device** | Electron's bundled Chromium on your computer | Stored for your Instafy account across projects on this device. Explicitly approved tab control or Explore can use that account; the profile stays local. |
| **Workspace browser** | Chromium in the managed project runtime | Project members viewing that same browser, including from web, mobile, and Desktop. Input still requires control permission. |
| **Fresh — no saved logins** | A fresh headless Chromium context on an explicitly enabled self-hosted Linux runtime | Nobody inherits a previous login. The owner-local observation tool starts fresh for each call. |

Studio's selector uses the short labels **This device** and **Workspace**. The
local tab starts private; **Share tab** chooses its audience separately.
Compact icon-only controls keep the full ownership description accessible.
Fresh is a tool capability, not an interactive browser option in that selector.

Personal is separate from installed Chrome, Safari, and the system browser used
for OAuth. It imports neither their profiles nor their cookies. Opening the
Shared Browser does not copy Personal logins into it, and the fresh observer
cannot import either profile.

## What survives a change?

- **Personal, another project on the same device:** the same user's profile is
  reused, but the new project must receive fresh agent control and browsing
  approval. A previous project's routine-browsing grant is not inherited.
- **Personal, close/reopen or app restart:** persistent cookies and site data can
  survive. Signing out of Instafy revokes browser control; it does not erase that
  user's disk profile. Another account gets a different profile.
- **Shared, another viewing device or pixel transport:** it is the same remote
  browser, not a copy. Use **Sessions & resume → Copy resume link** to select the
  exact running session on another signed-in device. Multiple sessions require
  a choice; an unavailable target does not silently create a replacement.
  WebRTC, CDP screencast, and RFB do not select new profiles.
- **Shared, replacement runtime:** recovery requires enabled durable persistence
  and a usable saved snapshot. Persistence is default-off and controller-owned.
- **Shared, separate active runtimes:** there is no live cookie synchronization.
  A stored snapshot is not a continuously shared browser session. Conditional
  saves reject stale writers rather than overwriting a newer profile. After a
  conflict or uncertain save, that process stops saving until it is replaced
  or restarted with a successfully established baseline.
- **Fresh, another observation:** there is no login continuity.

Site expiration, session-cookie behavior, and server-side logout still apply.
Persistent profile storage cannot guarantee that every site's login survives a
restart. Cookies follow domain/path rules, while localStorage and IndexedDB are
origin-scoped; sessionStorage also depends on the browser's page session.

## Viewing and sharing control

Both interactive modes have an **Expand** control, including compact layouts.
It fills the app viewport; it does not create a different browser, profile or
OS window. Collapse returns to the docked browser with the same page.

**Always allow routine browsing** is an early, explicit choice: at the first
Shared site prompt for that turn, or before Personal Resume until paused.
It avoids repeated routine site/action prompts without changing cookie sharing.
Recognized high-impact actions still ask and secret entry remains manual; a
website can attach unexpected side effects to an otherwise ordinary control.
See each mode's policy for scope and revocation.

**Take over → fill highlighted fields → Done, continue** is a sequential handoff.
The browser must confirm that agent operations have stopped before manual input
is enabled. Done sends a fixed continuation, not entered values, and starts a
fresh browser turn on that page. Shared page contents are still visible to
project members; expansion and manual input do not make a Shared page private.

## Clearing data

**Clear Personal Browser data** clears your Personal cookies and site storage on
this device across all projects. It does not clear another Instafy user's
Personal profile, your Studio sign-in, Shared Browser, or installed Chrome/Safari.
Agent control is paused before the clear.

**Clear Shared Browser data** affects the project browser for everyone. It
requires Builder-or-higher permission, stops managed runtimes that may hold the
profile, and deletes the durable snapshot only after that shutdown is confirmed.
It does not clear Personal Browser. A failed shutdown leaves the saved profile
in place so the clear can be retried safely.

## Security and verification

Personal keeps its profile on this device. Explicit [local tab sharing](Local-Browser-Sharing.md)
can grant selected members viewing, human control, or an independent Explore page
using that account, without exporting the profile or granting runtime access. Shared grants
access to authenticated pages to project members; use a project-appropriate
account there. Even without a cookie import/export feature, page content an
agent observes may enter the configured AI provider's context.
The current Shared profile boundary does not isolate Chromium from other
processes inside the same project runtime; stronger OS isolation requires a
separate execution boundary, not just a different profile directory or viewer.

The local Electron persistence smoke uses a disposable website and profile. It
sets real persistent and HttpOnly cookies over HTTP, checks their server-side
echo, and covers reopening, application restart, project changes, account
isolation, separate Studio storage, and explicit clearing. It uses no real
website account and submits no AI turn. This is a Personal proof, not proof of
Shared snapshot recovery or cross-runtime synchronization.

For the execution and authorization details, see [Personal Browser](Personal-Browser.md),
[Shared Browser](Shared-Browser.md), and
[self-hosted runtime security](Self-Hosted-Runtime-Security.md).
