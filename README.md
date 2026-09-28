# Sign-up PR review evidence

Captured locally on 2026-09-28 using Google Chrome, local Vite at loopback port 5187,
and the existing local Supabase stack and mail catcher. No production accounts were created.

- Before: origin/main at b7525464, before editing LoginPage.
- After: code-first signup changes in commit 6fb2d334fcc170edc3c63d4672952280de435ecd.
- Desktop: 1440 x 1000. Phone: 390 x 844. Light and dark themes; reduced motion.
- The version label comes from the dev server started at the base commit.
- Email fixtures are synthetic. Six disposable local users across all checks were deleted.

The `email` screenshots show the state after choosing Create account and entering an email.
The `error` screenshots show the old raw credentials error and the new account-neutral copy.
The `code` screenshots show the new signup verification step, with no password form.

Real browser checks passed: four signup -> delivered local email -> eight-digit code -> real
session -> preserved destination journeys; identical mismatch copy for existing and missing
emails; signup intent with an existing email verifies into the same account; invalid refresh
state returns to login and password sign-in restores a real session.

The remembered-account smoke spec passed. The full stale-session smoke spec could not reach
its recovery assertions: the local controller returned HTTP 503 during organization creation.
The isolated auth recovery check above is narrower and does not qualify that Studio smoke spec.

These images are kept on a separate evidence branch so they do not enter the product diff.
