# Context hierarchy review

This isolated fixture renders the production organization rail, desktop header, space picker,
workspace tabs, History drawer, and shared typography/buttons. The sidebar navigation body and
Automations page body/header are sample content. The sample page heading intentionally mirrors
StudioTopBar's current single-page heading; this fixture does not mount the entire Studio route.

Data hooks and controller calls are inert local adapters. History review reports a local status;
revert reports a preview-only error. The unused desktop-changes child is omitted because every
History case uses stateless mode. No authentication, workspace filesystem, model, Git operation
or remote browser is connected, and Vite does not read environment files.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/context-hierarchy/vite.config.ts
```

Open `http://127.0.0.1:5368/tests/fixtures/context-hierarchy/index.html`.
Query options:

- `theme=light|dark`
- `collapsed=1`: collapsed navigation, with the History title inside its pane
- `home=1`: Home and its return action
- `tabs=1`: production workspace tabs in place of the sample page heading
- `shell=desktop`: integrated macOS layout geometry; no native traffic lights or window behavior
- `mobile=1`: standalone production History drawer at mobile widths, not mobile Studio navigation
- `controls=1`: show the fixture's theme/shell review controls

The default docked History width is 280px, matching Studio's conversation-workspace default.
Use the actual space picker, Search/Close, Collapse/Expand, team rail, Home/Back, History Refresh,
version review/expand and workspace tabs to inspect state changes. Sample destinations do not
prove application routing or authenticated integration.

Before screenshots were captured from production components before the prototype edits, using
identical fixture data and viewport settings. Screenshots are local review artifacts outside
source control. Root-font scaling and viewport simulation do not prove native accessibility
font settings, software-keyboard behavior or the Electron window-control hit areas.

Focused browser checks:

```sh
pnpm exec playwright test --config tests/fixtures/context-hierarchy/playwright.config.ts
```

The dedicated configuration uses the list reporter and only this fixture. It does not claim
that the full required browser CI inventory ran.

## Actual sidebar refinement

Add `sidebar=actual` to mount the production `StudioSidebar`, including its real organization
rail, New chat, collapse/expand control, navigation row geometry and account entry. In this mode,
project/org/profile/update data is supplied by inert local adapters through the real
`WorkspaceControlsProvider` and `BrowserRouter`. The space picker also comes from the sidebar.
No authenticated routing, backend operation, native window controls or dialogs are validated.
This mode is reviewed as a browser layout; `shell=desktop` remains a geometry-only sample mode.

The original sample-navigation mode remains available for the first before/after gallery.
The sidebar-refinement comparison captures actual sidebar markup on both sides; it does not
represent the replacement of sample geometry as a product change.

The grouped-actions comparison places a distinct New chat button beside Chats while expanded,
and directly below Chats while collapsed. Collapse/Expand stays in the navigation footer.
Focused actual-sidebar cases check independent chat actions, keyboard focus, stable footer-icon
position, 44px touch targets and short-height scrolling in both themes at desktop widths.
The separate mobile History cases do not exercise mobile Studio navigation.
