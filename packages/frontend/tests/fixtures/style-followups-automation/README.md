# Automation editor review

This fixture renders production `AutomationsPanel`, fields, schedule controls, modal/mobile editor, draft guard and status toasts. Only account/project/runtime/controller data are inert adapters. No automation runs or remote requests are made.

Run from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/style-followups-automation/vite.config.ts
pnpm exec node tests/fixtures/style-followups-automation/review.mjs
```

Open `/tests/fixtures/style-followups-automation/index.html?theme=light` on port 5238. Choose **Automation actions → Edit** to inspect a populated editor, or **New automation** for a new draft. Reload resets the adapter data.

- `theme=light|dark` sets the production theme.
- `schedule=weekly|once|hourly` controls the existing automation's schedule.
- `save=success|error|pending` makes Save resolve, retain the draft with a real error toast, or stay pending.
- Resolve a pending save with `window.dispatchEvent(new Event("review:complete-save"))` in the review browser.

Before/after review uses the same fixture. Set `INSTAFY_REVIEW_BASELINE_SRC` to a pre-change copy of the frontend `src` directory and override `--port 5239` for the before server. `AUTOMATION_REVIEW_ORIGIN=http://127.0.0.1:5239` runs the browser-flow script against that baseline.

The flow script checks desktop/mobile layouts, narrow/short viewports, light/dark themes, all schedule modes, weekday selection, dirty-draft dismissal, pending saves and error preservation. A resized viewport exercises available-height handling; this does not substitute for physical-device keyboard testing.
