# Composer and browser feedback review

This fixture mounts the production composer, goal controls, recording strip,
browser address field, status pill and attached feedback. The composer adapter
is shared with `run-stop-control`; only account, storage, submission and runtime
boundaries are inert. No microphone, browser session or model is started.

From `packages/frontend`:

```bash
pnpm exec vite --config tests/fixtures/composer-browser-feedback/vite.config.ts --host 127.0.0.1
pnpm exec playwright test --config tests/fixtures/composer-browser-feedback/playwright.config.ts
```

Open `http://127.0.0.1:5450/tests/fixtures/composer-browser-feedback/index.html`.
Parameters:

- `surface=actions|goal|recording|browser-error|browser-success|browser-status`
- `theme=light|dark`
- `goal=active|paused|blocked`
- `state=paused|starting|off|unavailable` for the browser status
- `disabled=1` for disabled composer actions; `pending=1` for unavailable Resume
- `draft=...` for a custom composer draft; `text=large` for 150% root text sizing

Desktop shows a chat alongside the browser. Below 768px only the selected
surface is shown, at the actual viewport width. The browser page and transcript
are local context, while the controls being reviewed are production components.

For before/after, set `INSTAFY_REVIEW_BASELINE_SRC` to a pre-change `src`
directory and run the same Vite command. The before server uses port 5451 and
the identical fixture data. Set `INSTAFY_COMPOSER_BROWSER_REVIEW_URL` when
running the spec against a different server.

The spec exercises 320/390px touch and 768/1280px mouse viewports in both
themes: preserved drafts when changing views, goal expansion/pause/resume,
recording layout, dismissing browser feedback, resuming control, keyboard
activation and disabled actions. It also checks enlarged text and short
landscape. This proves layout and local interaction, not native keyboard,
microphone capture, remote navigation or browser ownership transport.

Screenshots and review galleries belong outside source control.
