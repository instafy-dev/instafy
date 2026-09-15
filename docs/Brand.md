# Instafy Brand

Instafy uses one Octo mark, one identity ink, and a separate interaction blue.
The shape carries the identity; the surface determines whether the positive or
reverse color variant is used.

## Color roles

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Brand ink / navy | `brand-ink` (`brand-navy`) | `#0F172A` | Octo on light surfaces; branded dark tiles |
| Brand paper | `brand-paper` | `#FFFFFF` | Light surfaces; reversed Octo |
| Brand blue | `brand-blue` / `primary` | `#007ACC` | Buttons, links, focus, and active UI in light mode |
| Dark interaction blue | `brand-blue-dark` / dark `primary` | `#3794FF` | Buttons, links, focus, and active UI in dark mode |
| Brand sand | `brand-sand` / `secondary` | `#D7B686` | Restrained secondary accents, not the default Octo fill |
| Dark secondary sand | `brand-sand-dark` / dark `secondary` | `#E0C49A` | Accessible secondary accents on dark surfaces |

Brand ink is Instafy's identity color. It is not the generic dark-mode canvas
and it is not the interaction primary. The legacy `midnight` token is only a
compatibility alias for `brand-ink`; do not introduce another almost-navy.
Dark product surfaces remain neutral charcoal.

The browser/PWA `theme-color` is brand ink because it colors installed-app and
browser chrome. It does not make brand ink the button color or the dark-mode
page background. The shipped PWA pair is brand-ink chrome (`#0F172A`) with a
brand-paper launch background (`#FFFFFF`).

## Logo variants and surfaces

- **Positive:** brand-ink Octo on brand-paper or a light surface.
- **Reverse:** brand-paper Octo on brand-ink or a dark surface.

Inline React marks render with `currentColor`, so every call site owns the
contrast choice. The normal responsive treatment is
`text-brand-ink dark:text-brand-paper`; a branded tile uses
`bg-brand-ink text-brand-paper`.

| Surface | Shipped treatment |
| --- | --- |
| Light web/product UI | Positive; brand-ink on paper or transparent |
| Dark web/product UI | Reverse; brand-paper on the neutral dark surface |
| Octo agent avatar/chip | Positive brand-ink mark on a white circular coin in both themes |
| iOS and Android launcher icons | Reverse; brand-paper Octo on a brand-ink tile |
| App Store and Google Play app artwork | Reverse; brand-paper Octo on a brand-ink tile |
| Google Play developer profile artwork | Reverse; brand-paper Octo on a brand-ink tile |
| GitHub App and OAuth App badges | Reverse; transparent brand-paper Octo over GitHub's brand-ink circular badge background |
| PWA regular and maskable icons | Reverse; brand-paper Octo on a brand-ink tile |
| Desktop app | Reverse on a rounded brand-ink tile with transparent outer corners |
| Native splash | Positive; brand-ink on brand-paper |
| Adaptive SVG favicon | Positive or reverse according to the OS color-scheme preference |
| Fixed ICO/PNG favicon fallback | Reverse; brand-paper Octo on a brand-ink tile |
| Android 13+ themed icon | Monochrome Octo mask; Android chooses the user/system palette |
| Social/OG card | Current static positive composition on a light warm surface |

A reverse native splash is an approved future variant, but it is not currently
generated or configured. Add generator, status-bar, and navigation-bar support
before shipping one; do not hand-edit the derived splash PNGs.

The adaptive SVG reacts to `prefers-color-scheme`, not arbitrary custom browser
chrome themes. Fixed fallbacks deliberately remain the high-contrast navy tile.

Do not use brand ink on black/charcoal, white on white, bright interaction blue
as the standard Octo color, or pure black as a brand background. Do not redraw,
rotate, stretch, crop, or recolor individual pieces. The four detached nodes
are part of the mark, not optional decoration.

## Typography

The web UI and the shared Desktop/mobile workspace use the native system sans-serif font.
`--font-sans` in [the shared stylesheet](../packages/frontend/src/styles/tailwind.css) is the authority; `--font-instafy` is a compatibility
alias. No external UI font download is required. Native camera and operating-system controls
continue to use their platform fonts.

Code, logs, paths, and the file editor use the shared `--font-mono` stack. The editor resolves
that CSS value into a font-family string because its canvas measurements cannot use `var()`.

Use the shared roles in [typography.ts](../packages/frontend/src/styles/typography.ts) through `Text`, `Heading`, `Field`, and the
common controls. Keep typography separate from component padding and layout:

| Role | Default size / line height | Use |
| --- | --- | --- |
| Body | 14px / 21px at 900px and above; 14px / 22.75px below | Chat and reading text |
| Control | 14px / 20px | Buttons, menus, compact navigation |
| Caption | 12px / 16px | Secondary labels and hints |
| Text entry | 14px / 20px on desktop; 16px / 20px below 640px | Standard inputs and composer |
| Headings | Existing `Heading` / `Text` variants | Preserve the page and section hierarchy |

Extra-small text-entry controls use 12px / 16px on desktop and the same phone minimum as
standard inputs. The composer overlays share its text-entry role so placeholders, suggestions,
and recording indicators stay aligned. Its 20px lines also match the existing growth limits.
Keep the 16px mobile text-entry minimum and the existing focus/touch-target rules.

## Product motion

The canonical inline Octo may use the opt-in `thinking` motion state when Octo
is actively processing a request. Its restrained swimming cycle uses a slight
mantle pulse and one coordinated arm stroke: the mantle fills while the tips fan
outward, the arm middles cup the water, and the tips accelerate down and inward
as the mantle contracts. A moving coast and shallow open recovery complete the
loop without a duplicated rest frame or replaying the power stroke backward.
Detached nodes follow the terminal
direction of their tentacles instead of hanging below them like fixed weights.
The attachment points remain pinned, and each loop returns to the exact static
geometry. Do not add continuous waving, whole-mark bobbing, or a second recovery
stroke. Waiting for a runtime, requesting approval, compacting context,
finalizing, and completed messages remain still.

Motion is product state, not a second logo variant. Favicons, OAuth badges,
native/store artwork, headers, login forms, and inactive or historical
transcript avatars remain static. The current live-run speaker avatar and the
thinking row may animate. Custom agent avatars are never given Octo's motion.
The motion must disappear under `prefers-reduced-motion: reduce`, and compact
chat layouts use the same animated mark beside the thinking status because the
avatar gutter is intentionally hidden on phones.

Full-screen route and authentication loading may reuse the canonical swimming
cycle while the requested route or session restoration is pending. Show a single
decorative Octo above the polite status text “Getting things ready…” without a
wordmark. Reduced motion keeps this mark still, and the loading screen disappears
when the destination or login form is ready. This exception does not animate login
form logos, header logos, or runtime-waiting states.

Initial Studio space resolution uses this same surface. After the workspace is visible, keep
loading indicators local to their content instead of replacing the full screen. Local spinners,
pulsing activity indicators, and status-text shimmer stop under reduced-motion preferences;
their static label or icon remains visible. Loading text must remain legible in both themes.

A clearly labeled landing-page workspace example may use the same thinking
state beside its simulated active work. Keep one example visible at a time,
provide a motion pause control, and suspend motion offscreen and in hidden
browser tabs. The example does not animate the header logo or completed output.

## Scale, clear space, and wordmark

Distribution exports place the canonical 64-unit drawing at `0.85` scale,
which reserves 15% of the canvas across both axes before a platform applies its
own mask. Keep that optical padding and keep maskable artwork inside the
platform safe zone. Use the generated favicon at 16px; do not manually simplify
or squeeze the mark for smaller sizes.

For a standalone inline mark, leave at least one detached-node diameter of
clear space around the visible artwork. When paired with the product name, use
the exact text `Instafy` in the product's bold sans-serif UI style, align it to
the visual center of the mark, and leave at least one detached-node diameter
between mark and name. The text is a lockup, not a second source of logo
geometry.

## Source of truth and generated assets

The canonical Octo geometry is
`packages/frontend/src/assets/octo-mark.geometry.json`. Distribution color,
scale, and cache revision live in `scripts/app-icon-brand.json`.
`OctoMark.tsx`, the icon generator, and the checker consume those sources.
`octoMarkMotionGeometry.ts` derives transient, command-compatible thinking
frames from that same geometry; it is not a second hand-drawn logo source.
Generated PNG/SVG/ICO files are outputs and must not be edited by hand.

`packages/frontend/public/og-image.png` is the one current static social-card
exception. It uses the positive mark and wordmark composition, is checked for
its 1200×630 delivery shape, and should move into the generator if its artwork
is redesigned.

After changing geometry, color treatment, or distribution scale, run:

```sh
pnpm generate:app-icons
pnpm check:app-icons
```

When icon pixels change, increment `cacheRevision` and update every versioned
consumer in the same change. The checker requires one shared revision across:

- `packages/frontend/index.html`
- `packages/frontend/public/manifest.webmanifest`
- `packages/frontend/public/sw.js`

Private distributions must pin the same revision for any additional branded surfaces.
The service-worker cache version must use that revision too. This prevents an
existing browser or installed PWA from retaining the previous identity.

## Distribution notes

iOS App Store icons must be opaque. Google Play artwork must remain 512×512
RGBA and under 1 MiB. Android adaptive foregrounds must stay inside their
visible viewport; themed icons are intentionally OS-recolored. Native launcher
or desktop-icon changes require a new binary, and iOS uploads require a unique
build number. Google Play listing and developer-profile artwork are separate
manual console uploads today. GitHub App and OAuth App settings also require a
manual upload of the transparent, sub-1 MiB
`packages/frontend/store/github-app-badge-logo.png` plus the badge background
color `#0F172A`; each distinct registration must be updated separately. See
the relevant platform's release documentation for build and upload steps.
Private distributions should keep their signing and promotion runbooks outside
the public core.
