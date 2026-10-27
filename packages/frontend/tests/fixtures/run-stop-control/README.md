# Run Stop playground

From `packages/frontend`, start the secret-free component server:

```sh
pnpm exec vite --config tests/fixtures/run-stop-control/vite.config.ts --host 127.0.0.1 --port 5208 --strictPort
```

Open `http://127.0.0.1:5208/tests/fixtures/run-stop-control/index.html`.
Append `?navigation=compact` to inspect the rounder compact navigation composer.

The playground mounts the production composer, Lexical editor, Stop hook/control,
typing status, the turn's activity line and Details, menus, dialogs and styles. Scenario controls supply synthetic jobs
and a fake cancellation transport. It never authenticates, contacts a controller or
cancels a real run. Credential/provider modules, storage and the closed browser/invite panes are replaced
with inert boundaries. This is component verification, not backend integration proof.

Try the thinking, steps, command, two-agent, other-person, read-only, failure,
timeout, already-finished and delayed-live-status cases. Restart resets the selected
case; Simulate completion also exercises the hidden typing-status spacer. A successful
stop shows the production attributed notice; Continue submits one synthetic instruction
and starts a fresh job/run identity through the production continuation hook. Light/dark
controls and browser device emulation can be used to inspect the same layout.

The square Stop occupies the empty composer’s trailing slot. Typing a draft keeps
Send available beside it; stopping preserves the draft. Recording keeps its microphone.
The transcript contains status only. All sends and voice capture in this fixture are simulated.

The required browser UI lane includes `run-stop-control.spec.ts` and the companion
`turn-activity-line.spec.ts`. For a focused run with an installed Chrome:

```sh
PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome pnpm exec playwright test --config playwright.ci-ui.config.ts run-stop-control.spec.ts turn-activity-line.spec.ts --reporter=list
```
