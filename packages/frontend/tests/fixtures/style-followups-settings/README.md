# Settings style review

Run from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/style-followups-settings/vite.config.ts --port 5236
```

Open `/tests/fixtures/style-followups-settings/index.html?surface=invite-conflict&theme=light`.
Both `light` and `dark` work with these surfaces:

- `invite-conflict`, `invite-pending`, `invite-prepared`, `invite-error`
- `appearance`
- `notifications`, `notifications-error`, `notifications-blocked`
- `nudge`, `nudge-error`, `nudge-pending`

Click Enable for the nudge's error or pending state. The first error attempt fails;
retry succeeds. The pending scenario deliberately stays pending. Notification
preferences Retry recovers, and permission/preference changes complete after 650ms.
Prepared-invite Share and Copy also complete after 650ms without external effects.

The visible settings, notices, theme control, fields and buttons are production
components. `adapters.ts` replaces notification persistence, device permission,
clipboard, sharing and status delivery with inert local effects. The unused
provider-binding and space-identity imports throw if rendered; this fixture covers
only the guest-access branch. It does not authenticate, send invites, write to a
clipboard, request operating-system permission, or contact a controller.

Use `INSTAFY_REVIEW_BASELINE_SRC` with the shared fixture config to render saved
pre-change source through the identical fixture. No baseline source is committed.
Capture mobile with a coarse primary pointer and desktop with a fine pointer;
check the pointer mode before and after taking screenshots.
