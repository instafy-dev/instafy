# Organization surface review

Local visual fixture using the production `StudioOrganizationRail`,
`StudioDesktopHeader` and `StudioContextLayout.css`. The inner navigation and
workspace are explicitly marked sample content. No account, controller or
backend is connected, and no environment files are loaded.

Run from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/organization-surface/vite.config.ts
```

Open `http://127.0.0.1:5215/tests/fixtures/organization-surface/index.html`.

Query parameters:

- `version=before|after`: before restores only the original organization and
  navigation surface variables. After uses production CSS unchanged. Both use
  the same production curve geometry.
- `theme=light|dark`
- `collapsed=1`
- `org=workshop|studio|research|personal`
- `home=1`
- `shell=browser|desktop`: desktop simulates the integrated title-bar layout;
  it does not claim to test a native Electron window.
- `controls=0`: omit the review toolbar so the application header starts at
  y=0 when reviewing inside an isolated native Electron window. Combine with
  `shell=desktop`; traffic lights must be supplied by the native window.

The preview intentionally keeps the desktop shell at a minimum 760px width.
It does not simulate mobile navigation. Controls can switch themes, versions,
teams, Home and expanded/collapsed navigation during review.
