# Menus and forms review

This mounts the production Secrets and Your AI pages and shared Select. Data boundaries
use in-memory sample records; provider connection/upload transports are disabled. These
are UI checks, not authentication, controller integration, or native-keyboard tests.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/menus-forms/vite.config.ts
pnpm exec playwright test --config tests/fixtures/menus-forms/playwright.config.ts
```

Open `/tests/fixtures/menus-forms/index.html`. Optional query parameters: `panel=connections`,
`panel=pickers`, `error=1` (the first Secrets read fails, Retry recovers), `long=1`
(long secret name), and `slowTest=1` (connection tests wait five seconds instead of
700 milliseconds, so progress can be reviewed). Actions only affect this page's sample
data until reload.

The isolated test configuration starts its own server on port 5208. Set
`INSTAFY_REVIEW_URL` to reuse an already-running fixture server. Set
`INSTAFY_REVIEW_SCREENSHOTS` to an **external** artifact directory to preserve screenshots;
do not commit generated PNGs.

For a before/after comparison, copy `src` and `tailwind.config.ts` to a temporary directory
before changing production files, and symlink that directory's `node_modules` to this
package's installed dependencies. Start a second fixture server with
`INSTAFY_REVIEW_BASELINE_SRC` pointing to the copied `src` directory. The same data stubs
and fixture run against those source files. Capture it with `INSTAFY_REVIEW_CAPTURE=before`
and `--grep 'menus and forms'`; that capture skips assertions about newly introduced layout.
