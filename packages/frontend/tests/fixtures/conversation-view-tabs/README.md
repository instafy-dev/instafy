# Conversation views and composer queue

This local fixture mounts the production conversation tabs, chat composer and
queue actions with isolated sample data. It does not authenticate, dispatch a
real message or require a controller.

From `packages/frontend`, start the preview:

```sh
pnpm exec vite --config tests/fixtures/conversation-view-tabs/vite.config.ts
```

Open `/tests/fixtures/conversation-view-tabs/index.html?context=composer&queue=3&navigation=compact`.
Use `theme=dark` for dark mode, `placement=header` for desktop navigation,
`queue=6` for a scrolling queue, `stash=1` for a saved draft, and `draft=example`
to exercise protection of an existing composer draft. The default page without
`context=composer` previews the view tabs, with optional `files` and `approval`.

For composer utility and saved-draft review, use
`?context=composer&navigation=compact&utilities=1&queue=3`.
This adds a blocked goal with expandable details, one removable attachment and
three saved drafts (including a long preview). `goal=active` or `goal=paused`
selects the initial goal state. Pause, Resume, Clear, Help unblock, stash restore
and delete, attachment removal, and Expand draft use local state. Use the `+`
menu's Expand draft action to inspect Collapse draft. Add `placement=header` for
desktop navigation. Existing fixture defaults are unchanged.

Use `attachments=1`, `attachments=4` or `attachments=12` for one, several or many
removable image previews, with long filenames after the first image. The option
also works without `utilities=1`; `attachments=0` hides the attachment tray.
Check that previews stay above the text input within the composer, that longer
lists scroll while the input stays reachable, and that removal works in both
normal and expanded drafts. The browser tests cover 320, 390 and 1280px in both
themes, including expanded-draft scrolling and keyboard removal.
Add `sending=1` to keep the sending status visible while the previews scroll and
disable removal; this simulates an in-progress upload without sending data.

Add `messages=1` to show the production `UserMessageBubble` with three 96px
image thumbnails alongside the composer's 48px thumbnails. Both use the real
image preview overlay; open a preview with Enter, close it, then remove a
composer image. At 320px the sent images wrap within the bubble. The browser
checks verify the shared radius, lack of an idle shadow, visible keyboard focus,
preview opening and removal in light and dark themes on mobile and desktop.

The local sample reuses the existing `../../../public/og-image.png`: Instafy's
1200×630 social-card design (83,531 bytes), already approved by the public
boundary policy. It is imported from its original path rather than copied or
modified. This is a real design asset, not a workspace screenshot. The fixture
reuses it for each attachment; the `File` contains its actual PNG bytes, and
Vite's inline preview URL keeps every image local. The message fixture replaces
account, conversation, runtime, workspace and optional feature data boundaries
with inert adapters; no controller or model is contacted.

For the pending new-tab token, add `&newtab=1` to the composer context
(`?context=composer&newtab=1`): the composer shows "New tab for the next
message" above the input, and its Cancel new tab button removes it. The chat has
no page strip of its own; the Browser view tab and the browser pane's tab picker
list the browser's pages. In the view-tab context, `page=<title>` names the
browser's active tab in the Browser tab's tooltip and description, and `agent=1`
shows the violet dot read as "Octo is using the browser". Review at 320, 390, 768 and 1280px with light/dark
themes and fine/coarse pointers.

The required browser UI suite includes `queue-composer.spec.ts` and
`conversation-surfaces.spec.ts`. They cover draft protection, edit/save/cancel
order, sending and removal, mouse/touch/keyboard reordering, read-only controls,
narrow widths, themes and the joined composer toolbar. Controller persistence,
authorization and retry behavior are covered separately by the Rust send queue
database tests.
