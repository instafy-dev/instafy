# Dialogs, navigation and settings feedback review

This fixture mounts production components with inert local data. It covers History confirmation,
agent profiles, chat invitations, chat/space navigation and team-member feedback. It does not send
invitations, create real chats, copy links into the clipboard, upload images or contact a backend.
The invite flow's production hooks are retained; only their data/transport boundaries are replaced.
Fixture controls select examples and themes; they are not product UI.

```sh
pnpm exec vite --config tests/fixtures/dialogs-feedback/vite.config.ts --port 5209 --strictPort
pnpm exec playwright test --config tests/fixtures/dialogs-feedback/playwright.config.ts
```

Open `/tests/fixtures/dialogs-feedback/index.html`. `?panel=navigation` and `?panel=feedback` open
those examples directly. The test server uses isolated port 5211; an existing review server can be
selected with `INSTAFY_REVIEW_URL=http://127.0.0.1:5209`.

For a before review, set `INSTAFY_REVIEW_BASELINE_SRC` to a read-only copy of the frontend `src`
directory when starting Vite on a separate port. This maps the same fixture imports to the original
production sources, instead of maintaining duplicate example markup. Run browser tests against that
server with `INSTAFY_REVIEW_CAPTURE=before`. Set `INSTAFY_REVIEW_SCREENSHOTS` to an external directory
to save generated screenshots. Do not commit generated images.

Coverage includes 390px touch, 1280/2560px mouse, light/dark, 320px overflow and reduced-height dialogs.
Checks exercise focus return, safe initial confirmation focus, form drafts across resize, nested QR
return, starting a private chat from the invite menu, space search, More dismissal and invitation
recovery states.
This is component coverage, not authenticated integration or physical-device keyboard testing.

`button-presets.spec.ts` checks actual conflict, invitation, member and agent-footer actions:
14px labels, 12px corners, flat resting surfaces, 32px inline and 36px form targets for a fine
pointer, and at least 44px targets for a coarse pointer. Narrow mouse and wide touch contexts
verify that density follows the pointer rather than screen width. Keyboard focus, pending
callbacks and 320px wrapping are checked separately from resting appearance. `?panel=feedback&scenario=members`
opens populated member lists with inert pending actions; `?panel=actions` contains two direct
shared-Button examples to check text-variant geometry. Baseline mode skips new geometry contracts.

To capture only the action examples, run the same config with `button-presets.spec.ts --grep 'production actions'`.
This saves conflict, a conflict-detail closeup, expanded members, invite and agent-footer images
at 390/1280px in both themes. Captures keep the real viewport; the members example scrolls to its
list actions so a full-page screenshot cannot change the runner's touch emulation.
