# Workspace surface review

This test-only preview mounts the production `SkillsPanel`, `MachinesPanel` and `FilesPanel`.
The review header is a fixture control; the panels, typography, controls, menus, dialogs,
mobile behavior and draft-dismissal guard are the product components.

Run from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/workspace-surfaces/vite.config.ts
```

Open `http://localhost:5203/tests/fixtures/workspace-surfaces/index.html`.
Add `?panel=skills`, `?panel=machines` or `?panel=files` to choose the starting page.
Resize the browser and switch Light/Dark to review layouts. Use Back to revisit a page.
On Machines, choose **Agents: Several** to inspect chips wrapping across multiple lines;
**Single** restores the default example. Switching examples resets only the local agent data.

The dedicated Vite config disables environment loading and replaces data-boundary modules
with deterministic local adapters. Skill toggles, machine state, selection and agent pins
change only in-memory data. Reload resets it. Import submission is acknowledged locally;
it does not install a skill, send a model request, provision a machine or contact a controller.
Existing file edits and Save draft/Save version update only the in-memory file map and a
local version counter. They never write a workspace, filesystem, Git repository or remote.
No account, credentials or connected physical device is required.

For Files, use `?panel=files&filesScenario=read-only` to inspect the real permission state,
`filesScenario=read-error` to fail reading `docs/guide.md`, or `filesScenario=write-error`
to reject saves while keeping the editor draft. Reload resets contents; remove filesScenario
from the URL to return to the normal example. Add `filesList=long` for a scrollable folder with 30 local notes. The `docs` folder includes a deliberately long filename for truncation checks.
Use `filesScenario=unavailable` or `filesScenario=no-space` for the controller-off and
missing-space empty states.

Add `filesSave=manual` to hold a local file write in its saving state. Release it with
`window.dispatchEvent(new Event("review:finish-save"))` in the browser console. The
toolbar checks use this explicit fixture mode to verify focus, pending appearance and
completion without timing assumptions; it does not simulate a real controller.

`?panel=changes` mounts the production Changes drawer and its single-file and all-files
diff viewers with two inert Git diffs. Discard and revert return local review-only errors;
refresh reads the same fixture data and never runs Git or contacts a controller.

These are rendered product-surface checks with simulated data, not authenticated integration,
backend, Electron or native-device coverage. The fixture is not a production entrypoint.

Run the responsive interaction and agent-alignment checks from `packages/frontend`:

```sh
pnpm exec playwright test --config tests/fixtures/workspace-surfaces/playwright.config.ts
```

This starts a separate isolated server on port 5205 and exercises 390px touch,
1280px mouse and 2560px mouse layouts in light and dark themes. Screenshots cover
all three panels, menus, import dialogs and machine confirmations. Keep these
tests separate from the normal app server, which does not provide the data adapters.
The two focused agent checks compare label alignment with the first chip row,
including wrapping, on 390px touch and 1280px mouse layouts.

Files checks also exercise local edit/save, draft retention, read-only controls, read and write
failures, scroll restoration and a long filename at 320px. Undo/redo history is not simulated
by the local data adapter; the production controls are present but disabled in this fixture.

The browser suite writes desktop and mobile screenshots under
`packages/frontend/test-results/workspace-surfaces` for pull-request review. They are
generated artifacts, not checked-in visual snapshot assertions.
