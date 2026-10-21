# Participant control review

This fixture renders the production `ConversationRoster` (header placement),
`SharedBrowserChrome`, `SharedBrowserCollaborationControls`, browser location,
browser options, Expand and approval controls. Six example people include a long display name; the conversation
roster also includes two AI identities. Only local React state changes. There is
no authentication, controller, browser transport or remote page. The conversation
roster toggles its real shared drawer state and opens a labelled local member
preview in the shared modal shell. The actual participants drawer is outside this
fixture. Assistant handle lookup is a deterministic local adapter; avatar rendering
and all control styles remain production code.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/participant-controls/vite.config.ts --port 5232 --strictPort
```

Open `/tests/fixtures/participant-controls/index.html`. Query parameters:

- `state=self|peer|requested|incoming|agent|read-only|empty|approval` (default `self`).
- `theme=light|dark` (default `light`).
- `count=20` for a long, scrollable participant list (default six; maximum 24).
- `approval=1` to show the production approval prompt over any state's sample page.
- `compact=1|0` to force compact or expanded browser controls. Without it, the
  production width helper observes the real browser surface width.
- `controls=0` to hide only the fixture heading/state/theme controls for captures.

The request action adds the local participant to pending requests; granting
transfers ownership to the first requester; Release makes control available;
Take assigns it to the local participant. Browser option, location, expansion and
approval actions update the live `review-action-log` only. Address edits update the sample URL only; navigation controls follow local ownership.
No remote navigation occurs, and Allow/Deny does not change any permission outside the fixture.

Useful selectors are `review-conversation-surface`, `conversation-roster`,
`review-browser-surface`, `shared-browser-collaboration-toggle`,
`shared-browser-collaboration-control-action`, and `review-action-log`.
