# CLI login layout review

This fixture mounts production `CliLoginPage` as `instafy login` opens it, with a signed-in
account. Only the session and the Supabase settings the page reads are inert. No account,
database, network request or CLI is used, and the spec presses nothing that sends.

From `packages/frontend`, the spec starts the fixture's server on port 5343 and runs against it:

```sh
pnpm exec playwright test --config tests/fixtures/cli-login-layout/playwright.config.ts
```

To look at the page, start the server yourself and open
`/tests/fixtures/cli-login-layout/index.html?theme=light` (or `theme=dark`):

```sh
pnpm exec vite --config tests/fixtures/cli-login-layout/vite.config.ts
```

Set `INSTAFY_CLI_LOGIN_LAYOUT_URL` to run the spec against a server already running. The
required browser UI lane runs the same spec (`cli-login-layout.spec.ts`) against its own server.

The spec checks, with a mouse and on touch screens, that the masked token keeps one line at
default text size, that the hidden lines saying to move the pointer keep their room only where a
mouse may be, and that showing one, after a click from a pointer at rest, moves nothing. It does
not prove real hardware input, operating-system fonts or assistive technology.
