# Login keyboard layout review

This fixture mounts production `LoginPage`, shared inputs/buttons and real form transitions. Only authentication, OAuth and native-platform service boundaries are inert. No account, mailbox, provider, database or remote service is used.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/login-keyboard/vite.config.ts
pnpm exec playwright test --config tests/fixtures/login-keyboard/playwright.config.ts
```

Open `/tests/fixtures/login-keyboard/index.html?theme=light` (or `theme=dark`). `native=0` shows the browser Back action; `surface=recovery` opens password reset. Test values are `review@example.test`, any password and any numeric code. Authentication calls never leave the fixture.

Checks cover resized Android-style viewports, a simulated visual-only keyboard shrink, input/action visibility, document scrolling, draft retention, email/password/code/signup/reset transitions, errors, coarse-pointer text sizing, both themes and desktop. These checks do not open a physical keyboard or prove native autofill, password managers, IME composition or system Back; replay on the Android/iOS candidate.
