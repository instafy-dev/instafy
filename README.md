# Sign-up and email review evidence

Local review on 2026-09-28. Product changes: `1df59b785e667448210c3c0fda07a37c688db9ef`.

- `screenshots/`: original comparison from main `b7525464` to initial code-first signup `6fb2d334`.
- `password/`: optional password setup at 1440 x 1000 and 390 x 844, light/dark, plus the retryable save error.
- `emails/`: all six templates before/after, at 800px and 390px. These HTML previews use inert code and URL placeholders.

The app captures use local Vite and Google Chrome. The original code-first check used the existing local
Supabase stack. Password setup and delivered email checks used a dedicated temporary local Supabase
project (`instafy-signup-review`) on ports 55321/55324. That stack has been removed without backup;
all test users in it were disposable. The shared-stack smoke user was removed explicitly.

Verified locally: code-first signup; set password and fresh password login; skip and preserve the
session/destination; validation and save retry; actual delivered confirmation and sign-in codes;
recovery email link in a fresh browser, password update, and subsequent password login. The
`pnpm test:auth:email` test passed against the isolated stack. No production accounts or settings
were changed. Browser email previews do not qualify every Gmail/Outlook/native-client rendering.

Final frontend unit result: 619 files / 5,579 tests passed. TypeScript and build pass. Lint has one
existing warning in unchanged useChatScrollOrchestration.test.tsx. Template/mount/CI-routing Node
tests pass (17). Remembered-account smoke passes. The Studio stale-session smoke remains unverified:
local controller organization creation returns HTTP 503 before its recovery assertions.

These artifacts are on a separate evidence branch and do not enter the product diff.
