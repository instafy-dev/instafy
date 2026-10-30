# Instafy Brand

Instafy uses one Octo mark, one identity ink, and a separate interaction blue.
The shape carries the identity; the surface determines whether the positive or
reverse color variant is used. The mark comes in two colorways: the one-ink
system mark, and the crew mark, whose four nodes carry the crew colors on flat
display surfaces.

## Color roles

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Brand ink / navy | `brand-ink` (`brand-navy`) | `#0F172A` | Octo on light surfaces; branded dark tiles |
| Brand paper | `brand-paper` | `#FFFFFF` | Light surfaces; reversed Octo |
| Brand blue | `brand-blue` / `primary` | `#007ACC` | Buttons, links, focus, and active UI in light mode |
| Dark interaction blue | `brand-blue-dark` / dark `primary` | `#3794FF` | Buttons, links, focus, and active UI in dark mode |
| Brand sand | `brand-sand` / `secondary` | `#D7B686` | Restrained secondary accents, not the default Octo fill |
| Dark secondary sand | `brand-sand-dark` / dark `secondary` | `#E0C49A` | Accessible secondary accents on dark surfaces |
| Dark canvas | `studio-dark-canvas` (`colors.canvasDark`) | `#141414` | The dark product canvas; the dark `theme-color`, the reverse native splash and its system bars |
| Marketing paper | `--marketing-canvas` | `#F8F8F6` (dark `#141414`) | Canvas of the landing and login pages |
| Marketing dot grid | `--marketing-grid` | `#DCDAD2` (dark `#2E2E2B`) | The 24px dot grid drawn on marketing paper |
| Crew colors | `--crew-1` … `--crew-4` | See [Crew colors](#crew-colors) | The crew mark's nodes (the hero's ink, participant faces and pills take the same values from `landingCrew.ts`) |

Brand ink is Instafy's identity color. It is not the generic dark-mode canvas
and it is not the interaction primary. The legacy `midnight` token is only a
compatibility alias for `brand-ink`; do not introduce another almost-navy.
Dark product surfaces remain neutral charcoal. Brand paper stays `#FFFFFF`
(the PWA launch background and the icon contracts depend on it); the warmer
marketing paper is a separate canvas token for the landing and login pages.

### Navy inside and outside the window

**Inside the window, navy is only ink; outside it, Instafy wears navy.** In
the product and on its pages, brand ink is a figure: the logo, the landing
headline, input text. Every surface, and the chrome that frames the page, is
brand paper or the neutral dark canvas. Outside the window, where Instafy sits
among other apps, the same ink becomes the ground: the app icon, store art, the
GitHub badge and the fixed favicon fallbacks are brand-ink tiles. A studio with
no navy background is this rule working, not a sign that the tile is wrong.

The browser and installed-PWA `theme-color` is therefore the page's own
surface, never brand ink: brand paper (`#FFFFFF`) under a light color scheme
and the dark canvas (`#141414`) under a dark one. `index.html` declares one
`<meta name="theme-color">` per `prefers-color-scheme`, its inline theme
script points both at the stored app theme before first paint, and
`ThemeProvider` keeps them on the resolved theme afterwards (a chosen dark
theme on a light OS gets the dark bar), the way it already drives the native
status bar. The web manifest cannot vary by color scheme, so it carries the
light pair: `theme_color` and `background_color` are both brand paper. They
only color the install surfaces before the page's own tags take over (the
Android PWA splash and its bar, an installed desktop window's first title
bar), and brand paper there matches the light launch and the default theme; a
navy `theme_color` would flash a navy bar before the page replaced it.

## Crew colors

Four crew colors, in slot order, left to right:

| Slot | Name | Light set | Dark lift | Label on the fill |
| --- | --- | --- | --- | --- |
| 1 | Pink | `#FF3C9F` | `#FF3C9F` | Ink `#0F172A` |
| 2 | Green | `#1B864B` | `#3CA063` | White |
| 3 | Flame | `#FA5815` | `#FA5815` | Ink `#0F172A` |
| 4 | Violet | `#814AD0` | `#A672FA` | White |

Slots follow roster order with Octo skipped: on the landing, Ada is pink, Kim is
green, the scenario's own agent is flame, and violet is the fourth crew slot.
Octo is ink, never a crew color: its tile holds the one-ink mark (brand ink
on a white tile in light, brand paper on a dark neutral tile in dark; see
[One rule for faces](#one-rule-for-faces) and the Octo agent avatar/chip row
below); its glyphs use brand ink, or brand paper on dark, and its cursor in the
Shared Browser is the studio's white arrow with a brand-ink stroke (the page
under it is light in both themes). Every AI, Octo included, wears a rounded
square tile and every person a round coin. An agent other than Octo that takes
a crew slot fills its tile with the slot and its initial in the slot's label
color, never with the Octo mark in a crew color. Participant faces, pills and
cursors keep the light set in both themes, each with the label color above;
only the crew mark's nodes and the hero's ink use the dark lift. The crew
mark's nodes read the theme-aware `--crew-1` … `--crew-4`
(`packages/frontend/src/styles/tailwind.css`). The hero's ink, which Cub draws
on his own canvas, reads `packages/frontend/src/screens/landing/landingCrew.ts`
instead (`CREW_SLOTS`, and `CREW_DARK_LIFT` in dark), the same file that holds
the fixed fill and label pairs; a unit test keeps the file, the variables and
the engine's own defaults equal. The product's own avatars keep their separate,
ID-hashed palettes.

## Logo variants and surfaces

- **Positive:** brand-ink Octo on brand-paper or a light surface.
- **Reverse:** brand-paper Octo on brand-ink or a dark surface.
- **Crew mark:** the positive or reverse mark whose four nodes take the crew
  colors, slots 1 to 4 left to right, with the dark lift on dark surfaces. The
  body and arms stay in the one ink.
- **One-ink system mark:** every piece in the one ink. This is the default and
  the only colorway below 28 CSS px.
- **One logo at every size:** there is no small-size redraw. Marks shown at
  24 CSS px (or points) and below draw the same canonical geometry, one ink,
  enlarged to fill the icon (see [full-bleed](#scale-clear-space-and-wordmark)):
  the favicons (`icon.svg`, the 16 and 32 px entries of `favicon.ico`, and
  `icon-32.png`) and the smallest desktop representations (the 16 pt slots of
  `icon.icns`, in their 12 and 26 px grid bodies, and the 16 and 24 px entries
  of `icon.ico`). In-app `OctoMark` draws the same geometry at every size too.

Inline React marks render with `currentColor`, so every call site owns the
contrast choice. The normal responsive treatment is
`text-brand-ink dark:text-brand-paper`; a branded tile uses
`bg-brand-ink text-brand-paper`.

`OctoMark` takes a `colorway` prop:

- `ink` (default): the one-ink system mark.
- `crew`: crew nodes. Only on a flat surface (never over artwork, imagery or a
  gradient) and at 40 CSS px and up. A light surface must be `#F6F6F6` or
  lighter (white, the marketing paper), because pink and flame fall below 3:1
  on anything darker; a dark surface must be a flat neutral dark. On slate-100
  or any mid-tone surface, use the one-ink mark.
- `crew-hidpi`: for 28 to 39 CSS px lockups such as the header. Crew nodes at
  1.5 device pixels per CSS pixel and up; one ink at 1x, where a node would be a
  3 px speck.

Octo's tile, agent tiles and every mark under 28 CSS px stay one ink. The nodes
are never omitted, reordered or recolored outside the crew slots, and there is
no dotless variant. The logo is faceless: no eyes or expression. Eyes and
expressions belong only to Cub, the landing hero's character, who has no blush.

| Surface | Shipped treatment |
| --- | --- |
| Light web/product UI | Positive; brand-ink on paper or transparent |
| Dark web/product UI | Reverse; brand-paper on the neutral dark surface |
| Octo agent avatar/chip | Light: positive brand-ink mark on a white rounded square tile (a 30% radius at the full slot) edged by the soft avatar coin shadow (`shadow-avatar-coin`) that every face shares and the 1px hairline every AI tile draws just inside its edge, ink at 14% (`--color-ai-tile-edge`); no ring and no border. Dark: reverse brand-paper mark on a `#262626` tile (`--color-octo-coin-dark`) whose hairline is 22% white (`--color-octo-coin-ring-dark`), and no shadow. Always one ink. See [One rule for faces](#one-rule-for-faces) and [Octo's tile](#octos-tile) |
| Other faces (people round, every other AI a tile) | Light: the same soft avatar coin shadow as Octo's tile, and no grey border, ring or other shadow; every AI tile adds the same inside hairline as Octo's. Dark: an AI tile's hairline is 22% white; a person's coin keeps its own hairline border or small shadow. See [Every face's edge](#every-faces-edge) |
| Landing header lockup (30px, 28px on phones) | `crew-hidpi` on the flat marketing paper; Install and News headers stay one ink |
| Login card mark (48px) | `crew` on the opaque card (plain paper on phones and in extension embeds) |
| iOS and Android launcher icons | Crew tile: a brand-paper body with the dark crew set on a brand-ink tile (every Android density, from mdpi's 48 px, and the iOS 1024 px icon that Xcode derives the other iOS sizes from). The round launcher and the adaptive foreground carry the same crew mark. The one iOS size under 48 px, the 20 pt@2x (40 px) notification slot, has its own one-ink tile (`AppIcon-20@2x.png`, main cut at 0.85, since iOS masks it like every other size) |
| iOS 18+ Dark app icon | The same mark on a transparent ground, so the system's dark background shows through: a white body with the dark crew set at 1024 px (`AppIcon-Dark-512@2x.png`), one ink in the 40 px slot (`AppIcon-Dark-20@2x.png`). Same placement as the default icon |
| iOS 18+ Tinted app icon | One ink, a fully opaque greyscale image: the white mark on black (`AppIcon-Tinted-512@2x.png`, `AppIcon-Tinted-20@2x.png`), written as RGB, never a grey color space. The system maps its luminance to the person's tint, so the nodes tint with the body and never carry crew color; its black is the darkest step of that tint, not a brand background |
| App Store and Google Play app artwork | Crew tile: brand-paper body, dark crew set, brand-ink tile |
| Google Play developer profile artwork | Crew tile: brand-paper body, dark crew set, brand-ink tile |
| GitHub App and OAuth App badges | One ink, reverse; transparent brand-paper Octo over GitHub's brand-ink circular badge background. GitHub draws the badge down to 20 px, so it never takes crew |
| PWA regular and maskable icons | Crew tile: brand-paper body, dark crew set, brand-ink tile. The maskable icons draw the mark at `0.78` instead of `0.85`, so every node, the outer pink and violet included, stays inside the W3C safe zone (a centered circle with a radius of 40% of the icon) |
| Desktop app | Crew tile on a rounded brand-ink tile, each size drawn at its own size: one ink under 48 device px of tile and crew from 48 px. macOS uses `icon.icns`, on the macOS icon grid: the tile is the 824 px body of a 1024 px canvas with Apple's continuous corners and fully transparent margins, rounded per slot as Apple's own icons are (16 → 12, 32 → 26, 64 → 52, 128 → 102, 256 → 206, 512 → 412, 1024 → 824), so it is the same size as its neighbours in the Dock and Finder; the 16 pt slots draw the one-ink mark full-bleed in their 12 and 26 px bodies, the 32 pt slot (a 26 px body) the one-ink mark at 0.85. Windows uses `icon.ico` and Linux the 1024 px `icon.png`, both full-bleed rounded tiles (radius 22%) with transparent outer corners; the `.ico` draws the mark full-bleed in its 16 and 24 px entries and at 0.85 from 32 px |
| Native splash, light (iOS launch screen, Android splash) | Crew, positive: brand-ink body with the light crew set on brand paper |
| Native splash, dark | Crew, reverse: a white body with the dark crew set on the dark canvas (`#141414`), the same size and placement as the positive splash. iOS registers it as the Splash image set's dark appearance (`splash-dark-2732x2732*.png`); Android ships it under the night qualifier (`drawable-night` and `drawable-{land,port}-night-<density>`, since orientation outranks night mode). The Android launch theme (`values/styles.xml`, `values-night/styles.xml`) paints the Android 12+ system splash and both system bars with the generated ground (`splash_background`: brand paper, or the dark canvas under night) and sets dark bar icons on paper, light ones on the dark canvas |
| Adaptive SVG favicon (`icon.svg`) | The logo, one ink, full-bleed: brand ink, or brand paper under a dark OS color-scheme preference |
| Fixed ICO/PNG favicon fallback | One ink, reverse on a brand-ink tile. `favicon.ico` 16 and 32 px and `icon-32.png` draw the logo full-bleed; the 48 px ICO entry draws it at 0.85. The page offers only `icon.svg`, `favicon.ico` and `icon-32.png` as `rel="icon"`, never a crew tile |
| Android 13+ themed icon | A dedicated one-ink layer (`ic_launcher_monochrome`), with the foreground's silhouette but never its crew colors; Android recolors it with the user/system palette |
| Social/OG card | The landing hero, cropped: a `crew` header lockup on flat marketing paper, the dot grid, the headline and sub copy, and the window's ledge with Cub on its corner looking at his crew ink; generated (see [Source of truth and generated assets](#source-of-truth-and-generated-assets)) |

Generated tiles follow one size rule: a tile of at least 48 device px
(`crewTileMinPx` in `scripts/app-icon-brand.json`, where the drawn mark is about
40 px and each node about 4.5 px) carries the crew mark; a smaller tile carries
the one-ink mark. The generator draws every size it ships at that size, so the
desktop `.icns` and `.ico` representations and the iOS 20 pt@2x slot under 48
px are one ink rather than a downscaled crew tile; on the macOS grid the
threshold applies to the tile's body. Monochrome contexts stay one ink at every
size: `favicon.ico`, `icon-32.png`, the GitHub badge, Octo's avatar, the
Android themed icon and the iOS Tinted icon. Crew on a tile, on the dark canvas
(the reverse splash) or on the system's dark background (the iOS Dark icon)
always uses the dark set; crew on paper (the positive splash) uses the light
set.

### One rule for faces

Every AI is a rounded square and every person is a circle. Octo is included,
with no exception and no hybrid, so a face says what it is even where no name
is printed: the 20px thread stack, the conversation roster, a phone's header.

- **An AI's face is a tile:** a rounded square with a 30% corner radius
  (`rounded-[30%]`) that fills its whole slot at every size, with no inset.
  The corners are a plain `border-radius`, never `corner-shape`, whose
  squircle WebKit draws as a circle. The tile keeps the shared avatar coin
  shadow (`shadow-avatar-coin`) and adds a 1px hairline drawn just inside its
  edge as an outline (`outline-1 -outline-offset-1`): ink at 14%
  (`--color-ai-tile-edge`) in light, the 22% white ring
  (`--color-octo-coin-ring-dark`) in dark. Being an outline, it paints over an
  uploaded picture and never fights a stack's separator ring. An outline
  follows `border-radius` from Safari 16.4, the floor Tailwind v4 already sets
  for the app; older WebKit would draw it square. The shape and the edge are
  `AI_TILE_SHAPE_CLASS` and `AI_TILE_EDGE_CLASS` (together `AI_TILE_CLASS`)
  in `packages/frontend/src/components/OctoCoin.tsx`; a surface reuses them
  rather than spelling its own radius.
- **Octo** is a white tile (`#262626` in dark) holding the one-ink mark at
  75%, the mark unchanged (see [Octo's tile](#octos-tile)).
- **Saved agents** wear the same tile with the fills they already have: the
  ID-hashed gradient with an initial, or an uploaded picture clipped to the
  tile.
- **A plan's helpers** (its workers) are AI too, so a helper drawn in a face
  slot is a tile. A helper's own face is pending a follow-up; until it lands,
  a helper falls back to a gradient hashed from its handle, with its initial,
  which is a stand-in, not its design.
- **People** stay round. `HumanAvatar`, a photo or initials on a muted
  ID-derived color, is a circle at every size.
- **Team and space identities** keep their own rounded squares (`OrgIdentity`,
  `SpaceIdentity`). They are places, not faces, and never sit in a face slot,
  so a square in a face slot always means an AI.
- **The word:** where a list mixes people and AI (the mention picker's rows,
  the participants drawer, the Shared Browser's participant list and agent
  profile cards), a quiet AI chip follows an AI's name: `AiTag`
  (`packages/frontend/src/components/AiTag.tsx`), 10px, medium weight, slate
  on a faint fill, with a small radius: the studio's quiet tag
  (`QUIET_TAG_CLASS`), the one the drawer already uses for a runtime's kind.
  The drawer's section for agents is headed AI (Runtimes & AI while it groups
  them by runtime). The chip never appears in thread rows or inside a
  sentence. The chip's comma is for screen readers only, so a row reads
  "Pia, AI", and an AI face or control that has an accessible name of its
  own adds ", AI" to it (`formatAiAccessibleName`: "View profile for
  @pia, AI").
- **What hugs a face follows it:** a Machines agent chip rounds its corners
  to the tile's, the tile's corner plus the gap beside it (9.2px around the
  chip's 24px face), instead of a person's stadium. A button that wraps an
  AI face alone, the transcript gutter's and a bot's picture button included,
  takes the tile's own corners (`Button` `radius="aiTile"`,
  `IdentityPhotoButton` `shape="aiTile"`), so its hover fill and focus ring
  never show past them; it is never a person's circle.
- **Stacks:** where faces overlap, the 1px separator is a ring on each face,
  so it follows each face's own shape (see
  [Every face's edge](#every-faces-edge)).

### Octo's tile

The tile is Octo's face wherever Octo appears as a participant in themed UI:
chat and transcript avatars, the thinking and typing rows, the
conversation roster, agent chips, the participants drawer, the mention picker,
thread participant stacks, the AI settings rows, and the landing's roster and
transcript. Every one of them renders the same component,
`packages/frontend/src/components/OctoCoin.tsx`, which is the only place the
tile is styled; a surface never copies its classes. The component keeps its
earlier name, `OctoCoin`, and its `data-octo-coin` hook. In light the tile is
white, edged by the shared avatar coin shadow and the AI tile's ink hairline
(below), so its corners read on a white bar, the slate-50 panel and the
`#F8F8F6` paper; there is no ring and no border. In dark the tile is `#262626`
with the faint hairline of 22% white and no shadow. The tile has no border, is
not positioned and draws no `::after`, so an overlapping stack keeps its tree
order, and the mark fills 75% of the tile so no arm reaches the edge at any
size used (20 to 64 CSS px) or anywhere in the thinking stroke. Where a thread
spine runs up into the tile, the tile sits above it. A surface that overlaps
faces (the conversation roster, a participant stack) adds its own separator
ring on the tile, which follows its corners. Other agents' faces and the
landing's scenario agent are tiles with their own fills, and human avatars are
round coins with theirs; all of them share its light shadow.

#### Every face's edge

In light mode every face, a person's (`HumanAvatar`, photo or initials),
Octo's and another AI's, carries one shadow: `shadow-avatar-coin`, a whisper
of an all-round hairline and a soft, short drop (`--avatar-coin-shadow`:
`0 0 0 1px` at 6%, `0 1px 2px` at 12% and `0 2px 6px -1px` at 10% of slate
ink, in `packages/frontend/src/styles/tailwind.css`), which follows the face's
shape. It is a shadow, never a border or ring: no grey border, ring or
`shadow-sm` on a face in light, so a white face reads on white by default and
the coloured faces sit in the same family. A person's coin has nothing else.
Every AI tile adds exactly one line, the inside hairline above (14% ink,
`--color-ai-tile-edge`), an outline drawn just inside the tile that keeps a
white tile's corners on white, where the shadow alone fades out at 20px; it is
the only outline a face carries. The shadow token is empty in dark, so the
shared shadow adds nothing there: an AI tile's edge is its hairline in 22%
white, and a person's coin keeps the edge it had (a hairline border or the
small shadow).

Where faces overlap in the studio (the conversation roster, a thread's
participant stack, the typing row's stack of agents), the separator between
faces stays, because without it the faces merge. It is a 1px ring on each face
itself, so it follows each face's shape (a circle around a person, the tile's
corners around an AI); the face still fills its slot, and the ring falls just
outside it. The ring is white in light; in dark it is the chat panel's color in
the roster and the typing row, and slate-950 in a thread's participant stack.
It sits above the face's shadow and outside an AI tile's inside hairline, so
the two never meet. Each face's soft shadow then falls outside a clean edge,
and the face after covers the one before (tree order, nothing positioned). The
landing's roster, whose faces sit apart, puts its ring on each face's slot
instead, under the face's shadow (see
[Marketing surfaces](#marketing-surfaces)). A wrapper that clips
(`overflow-hidden`) never sits tight around a face unless it is the face's own
shell, in the face's own shape, and carries the shadow itself, as the mention
picker's face does.

Static exports keep their own artwork: the favicons, `public/` icons, and
native and store art are unchanged by the rule for faces.
`packages/frontend/src/assets/octo-avatar.svg`, the generated avatar file and
still the identity the product resolves for Octo (`OCTO_AVATAR_SRC`), is a
white rounded square with the one-ink mark, like Octo's tile: the generator
draws it with the tile's 30% corners (`rx` 19.2 of 64), and
`pnpm check:app-icons` requires those corners to match `AI_TILE_SHAPE_CLASS`
and rejects the retired circle. No themed product surface draws that file as
an image any more; each one that sees it draws `OctoCoin` instead.

The reverse native splash is generated with its positive twin and configured
for both platforms, status and navigation bars included (see the splash rows
above). On Android the dark launch also carries through to the first page
paint: `MainActivity` paints the WebView with `splash_background` and, under a
night system theme, hands the StatusBar plugin `ThemeProvider`'s dark bar
(`#181818`, light icons) in place of the light pair in `capacitor.config.ts`,
so no white bar or white WebView appears before `ThemeProvider` runs. Do not
hand-edit the derived splash PNGs, the splash image set's
`Contents.json` or the generated `splash_background.xml` colors; change the
generator.

The adaptive SVG reacts to `prefers-color-scheme`, not arbitrary custom browser
chrome themes. Fixed fallbacks deliberately remain the high-contrast navy tile.

Do not use brand ink on black/charcoal, white on white, bright interaction blue
as the standard Octo color, or pure black as a brand background. Do not redraw,
rotate, stretch, crop, or recolor individual pieces; the crew colorway is the
one sanctioned exception, and it colors only the four nodes, in slot order. The
four detached nodes are part of the mark, not optional decoration.

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
chat layouts show the same animated avatar, tile included, beside the
thinking status because the avatar gutter is intentionally hidden on phones.

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

Cub is the landing hero's pen-drawn octopus, an illustration tier like the
glossy tentacle artwork it replaces: he is not the logo, he never stands in for
Octo, and the faceless logo and Octo's tile are unchanged by him (the hero's
surfaces are under [Marketing surfaces](#marketing-surfaces)). He perches on
the example window: on its top-right corner from 1000px, along its top edge
on narrower desktop windows, and on its top edge beside the scenario chips on
phones. He idles and breathes, notices the visitor once he is on screen (a
small jig and a happy squint), follows a fine pointer with his eyes and a
curious arm, glances at the primary entry on hover or keyboard focus, and
glances at the new opener after a scenario pick. On a first visit the example
holds its first turn on the opener until he has said hello, so the visitor
sees him notice them before anything else moves; it never waits long for him
(about three seconds for him to appear, five more for the hello) and not at
all when he cannot draw. He never greets the visitor while he lends Octo an
arm: if a turn is already running, the greeting waits until the arm is home
and his eyes have rested. While Octo works he lends Octo an arm: it runs along
the ledge and hooks onto Octo's roster tile, just under the ledge beside him,
as the prompt is sent, taps once per step, pats twice when Octo is done and
lets go before the teammate replies, all inside Octo's workspace run (every
scenario's run keeps the same beats, so the arm lines up with each), which
pops Octo's tile for the run and gives under each tap; every tap and pat lands
on the tile as drawn, level on its flat top and lower round a corner. A click
or tap on Cub squirts four splats of crew ink onto the window's ledge, in logo
order (pink, green, flame, violet, with the dark set's green and violet
lifts); the ink lands only on paper and the ledge, never on text, the entries,
the chips, the faces or the window's controls, and in light mode it soaks into
the paper (multiplied, the dot grid showing
through). A set holds for about two seconds and fades, or fades early when the
next squirt lands; a scenario change leaves it on the wall. His body takes the
exact page and panel colors behind it, so he never shows as a blob. His idle
arms never rest on the headline, the copy, the entries, the chips, the faces or
the window's chrome actions; the one sanctioned contact is the lent arm's taps
and pats on Octo's tile while Octo works. He never blocks a link or a button.

Reduced motion keeps Cub on one calm frame with no turn, no pop and no ink in
flight; a click shows the splats for a second, still. He renders with WebGL2 in
a separately loaded chunk, imported only after the first paint and an idle
moment, so the page never waits for him. He draws only his own region, stops
completely offscreen, in a hidden tab and under reduced motion, and otherwise
breathes at a low frame rate until something moves. Without WebGL2, or when
the browser drops the context, a still of Cub sitting on the ledge takes his
place (loaded only then) and he returns when the context does; no error is
shown or logged. The still is captured from the landing itself
(`packages/frontend/scripts/capture-cub-fallback.mjs`) and is regenerated with
any change to his pose or perch; so is the layout his geometry tests run on
(`packages/frontend/scripts/capture-cub-landing-layout.mjs`, whose `--check`
fails when the page has drifted from it), and so is the social card, which he
also appears on (`pnpm generate:og-image`, under
[Source of truth and generated assets](#source-of-truth-and-generated-assets)).
Login shows no Cub. In a dev build of
the frontend a small Cub button at the bottom left of the landing (`?cub-dev=1`
opens it, `?cub-dev=0` hides it) switches theme, motion, eyes, the splash and
click reaction, the logo's dots, a debug overlay, a scrubbed or still turn and
the no-WebGL still for review; it never ships in a production build.

A workspace example below the hero, named by the scenario chips in the hero and
by the group label Choose a workspace example, may use the same thinking state
beside its simulated active work. Keep one scenario visible at a time and let
the deck rotate gently: each scenario stays for its own task, 11 seconds for a
workspace turn and 19.4 seconds for Launch a site, which leaves the finished
task on screen for several seconds before the next one starts, waiting while
the pointer or focus is on the chips or the window, and holding 20 seconds after
a manual choice. Under reduced motion the deck does not rotate at all, and both
rotation and the thinking state stop offscreen and in hidden browser tabs.
Rotation must never move focus or shift layout, and the first paint shows the
beat the window starts on, never the finished turn fading out. The example does
not animate the header logo or completed output.

The example is one scripted task drawn with the studio's own chrome: one turn,
plus the browser handoff that turn asks for when it needs one. Ada types into
the composer (when the composer is below the fold, as on a laptop's first view,
the task opens on the sent prompt instead, and everything from Octo's work on
keeps its time, so Cub's hello still comes first), Octo works under the
studio's one activity line ("Editing files…" or "Running tests…" while a step
runs, "Thinking…" between steps, then what the run did, such as "Edited 3
files, ran tests", with Details beside it), the result lands in the message
that produced it and beside the conversation, and a teammate replies
only once that message is complete. The window keeps one fixed height, like the
studio's screen, and a conversation that outgrows it keeps its newest message in
view the way the chat does. Under reduced motion, offscreen and in hidden tabs
the window shows the finished task with nothing in motion.

From a 1184px viewport the window is as wide as a real split: it collapses the
rail to its 64px icons, and shows what the studio shows on a wide screen when a
file or the browser is open beside a conversation: the views bar under the tab
strip (Chat over the conversation, a tab per resource, Show one view at its
right end), the conversation on the left at 45% and the resource on the right at
55%, both full height, with the composer under the conversation only. There the
window also fits the first view: its height is the viewport less the window's
top and a 16px margin, between 19rem and its full 47rem, so the newest message,
the composer and the browser's stage down to its ticker are on screen without a
scroll (one fixed height per viewport, so no beat moves it). A rail that short
drops Credits, then Changes, the way the studio moves secondary tools into More.
Narrower windows show one view at a time, with Chat and the resource tabs in the
views bar from md and as a segmented control above the composer on phones (the
studio moves them beside the composer below a 900px app width; the landing
switches at md). Each scenario opens with the file its task starts from
already open beside the chat:

- Close the books: the bank export. The review file lands as a created file's
  card under the file rail (every row an added row: the studio has no table
  preview for a CSV), and in a split Ada's click on the summary's file
  reference (its hover tone shows first, so the file never opens on its own)
  opens it beside the chat, as plaintext with line numbers and the referenced
  row selected.
- Build a feature: the router. Octo's edit lands as the Updated card with its
  hunk, and the router beside the chat shows the new code with the change's
  first range selected (the import on line 2), as a click on the card's
  filename reveals it. The payment tests show as the studio labels a test
  run: "Running tests…" on the activity line while they run, and the command
  and its result in Octo's summary.
- Launch a site: the pricing notes. Octo builds the page, starts its dev
  server and a tunnel (Ada's prompt asks for the preview link, the consent the
  tunnel needs), posts the preview link, and asks to continue in the browser.
  Only Ada's press on that card opens the Shared Browser, so the press is
  staged to be seen: the card holds long enough to read, her press goes down on
  the button, then the button is busy (Opening browser…) while the Browser tab
  comes first and the studio's Starting Shared Browser card shows. Her
  continuation is sent once the session is up, and Octo's browser run asks her
  to approve the preview's site before it may read it: the prompt opens at its
  top with routine browsing unticked (Allow site), she scrolls it to the
  routine browsing box and ticks it, and presses Allow routine browsing. Then
  the page shows what the studio overlays on it: the edge glow while Octo
  controls it, the ticker in the runtime's own words (Go to the address, the
  page title, Scroll, Click "Choose Team"), each caption up for about a second
  to be read, Octo's unlabeled cursor at its click (the centre of the button,
  where the runtime clicks), and Kim's named pointer, which comes onto the page
  once it has scrolled and moves to the plan comparison as she answers, never
  onto the control Octo clicked. The page says only what the pricing notes
  say, and its own selected state is neutral, so no green on it reads as Kim's.
  In one view the press brings the browser to the front, and nothing in the
  studio switches back to Chat on its own: once Octo is done, Ada's press goes
  down on the Chat tab and the chat comes to the front with Octo's report and
  Kim's reply. The finished frame (reduced motion, offscreen, hidden tabs) is
  Kim's reply, under two seconds after Octo's click: inside the 4 seconds its
  cursor lingers, so Octo's cursor still rests on the button it clicked and the
  ticker, which fades after 6, still shows the click. While the task plays on,
  the cursor fades 4 seconds after the click. Never show what the studio does
  not do: an agent opening the browser on its own, a page that updates as files
  are written, a device viewport switch, a visible Ready pill or a deploy.

From 1184px the scenario chips sit on the entries' row, beside the buttons,
and on a short, wide screen (from 1184px wide and up to 960px tall) the
headline eases to 76px (64px up to 840px tall) and the window comes up a
little. Under 800px tall, the first view a 1366x768 or 1280x720 laptop leaves
once the browser's own chrome is drawn, the hero tightens further (a 54px
headline, the sub copy on two lines, less room between the parts) and the
window may shrink to 19rem, so the whole window, the browser's stage down to
its ticker included, fits the first view down to about 650px tall. Two departures from the studio stage it for
Cub, as in the approved hero: the conversation's roster sits in the window's
top bar, right-aligned and level with the ledge (28px faces, 10px apart; 24px
on phones, where the bar drops its sidebar toggle, bell and new-chat buttons so
the chat's title reads whole beside them), stopping short of the corner on
windows of 1000px and up to leave Cub room; and the expanded rail names each
scenario's space plainly (Finance, Checkout, Website). Cub's arms and ink keep
out of the conversation and the resource beside it, and his front arms hang no
lower than they did before the views bar came under the top bar. In a dev build
the Cub playground's Example switch (or `?deck-layout=single`) shows one view at
every width for review.

The example ships in the entry chunk every route loads, /studio and /login
included (the router imports the landing statically). On 2026-10-10 that
chunk was 588 kB (162 kB gzip) with the example in it, about 5 kB gzip more
than before the split and the browser came in. Keep that cost in view: if the
example grows again, load the window lazily behind a placeholder of its fixed
height (its height never depends on what it draws) instead of letting it ride
on every route.

## Marketing surfaces

The landing hero sits on the marketing paper (`#F8F8F6`, dark `#141414`) with
the 24px dot grid behind the hero only; the header sits plainly on the paper,
with no bar or blur, so its lockup (a 30px mark, 28px on phones, beside a bold
20px wordmark, 19px on phones) can carry the crew mark. The headline is all ink. The copy, the
entries and the scenario chips stack on the left (from 1184px the chips sit
beside the entries), and the right of the hero stays open above the example
window's top-right corner for Cub. The landing
keeps the approved hero's page gutter, header included: 24px on phones, 28px
from 768px and 40px from 1000px, so Cub's corner drape has room beside the
window. In dark mode
the example window's top bar takes the panel's surface (`#1D1D1D`), so the
ledge Cub sits on reads as a slab against the page.

The tentacle artwork and its presence cursors are retired. The landing's
participants wear the crew colors in roster order (Ada pink, Kim green, the
scenario agent flame), and Octo stays ink: its roster and transcript tiles are
the studio's own [tile](#octos-tile) (`OctoCoin`), white with the shared avatar
coin shadow and the inside hairline on light and reversed on dark, never a copy
of it. The faces follow the [one rule](#one-rule-for-faces): Ada and Kim are
people, so theirs are round coins (`AVATAR_SHELL` in
`packages/frontend/src/screens/landing/landingStudioChrome.ts`), and the
scenario agent is an AI, so its face is the AI tile in its crew fill
(`AVATAR_SHELL_AGENT`, built on `AI_TILE_CLASS`). In the roster each face's
separator ring takes its shape: `ROSTER_RING` is round for Ada and Kim, and
`ROSTER_RING_AGENT` follows the tile for Octo and the scenario agent. The faces
sit apart, so the ring sits on each face's slot, under the face's shadow, and
keeps a sliver of bar between a face and Cub's arm passing behind it. Ada's,
Kim's and the scenario agent's faces, in the roster, the transcript and the
rail's profile, take the same light shadow and no grey border. In dark, Ada and
Kim keep a hairline border and small shadow, and the scenario agent's only edge
is its tile's hairline, as Octo's is.

The login page uses the same marketing paper, with the dot grid full-bleed
behind its card from the `sm` breakpoint up; phones and extension embeds keep
plain paper. The card is opaque, so no dot shows through the form, and its 48px
mark uses the crew colorway. Login shows no character and no artwork. The
full-screen loading handoff ("Getting things ready…") sits on the marketing
paper too, so moving from the landing to login never flashes white.

## Scale, clear space, and wordmark

Distribution exports place the canonical 64-unit drawing at `0.85` scale,
which reserves 15% of the canvas across both axes before a platform applies its
own mask. Keep that optical padding and keep maskable artwork inside the
platform safe zone. At `0.85` the outer nodes reach 42% of the icon's width from
its center, past the W3C maskable safe circle (40%), so the maskable PWA icons
use `maskableScale` (`0.78`, about 38.6%). Android adaptive foregrounds already
stay inside their 66 dp safe circle at `0.85`.

One logo is used at every size. Marks shown at 24 CSS px (or points) and below
draw the same canonical geometry full-bleed instead of at the `0.85`
distribution scale: the mark's own ink box (the nodes at left, right and bottom,
the dome at top) is scaled to 56 of the 64 units, its height, and centered,
which leaves a 4-unit margin and keeps the lean, the proportions and the nodes
as they are. Full-bleed marks are always one ink: at these sizes they are
below every crew threshold. Never redraw, squeeze or simplify the mark for a
small size. A pixel-fitted small cut once shipped here and drifted from the
logo (a taller head with flared shoulders, longer and wider-spread legs, bigger
dots further apart), so the owner retired it for the logo itself. On
high-density screens, where a 16 px icon is drawn at 32 device px, the logo
reads clearly. At 16 device px (1x tabs, the 16 px `.ico` entries and the
16 pt@1x macOS slot) its legs are under a pixel wide and the nodes soften into
the arm tips; that is the accepted cost of one logo.

The threshold is in CSS px or points, not device pixels. A raster draws the
mark full-bleed only when it is 32 device px or less and is shown at 24 CSS px
or less: the 32 px favicon rasters (`favicon.ico`'s 32 px entry and
`icon-32.png`) and the macOS 16 pt@2x slot are the 2x rendering of a 16 CSS px
or 16 pt icon. A raster that can be shown at its own size above 24 px keeps the
distribution scale: the 32 px entry of the desktop `icon.ico` and the 32 pt
macOS slot. The iOS 20 pt@2x slot also keeps the distribution scale, because
iOS masks it like every other iOS size.

For a standalone inline mark, leave at least one detached-node diameter of
clear space around the visible artwork. When paired with the product name, use
the exact text `Instafy` in the product's bold sans-serif UI style, align it to
the visual center of the mark, and leave at least one detached-node diameter
between mark and name. The text is a lockup, not a second source of logo
geometry.

## Source of truth and generated assets

The canonical Octo geometry is
`packages/frontend/src/assets/octo-mark.geometry.json`, the only logo source
for every size. Distribution color, scale, the maskable scale
(`maskableScale`), the crew colors (`colors.crew.light` and
`colors.crew.dark`, slots 1 to 4 left to right), the crew tile threshold
(`crewTileMinPx`) and the cache revision live in `scripts/app-icon-brand.json`. `OctoMark.tsx`, the icon generator, and the
checker consume those sources. The generator ranks the nodes into crew slots
by `cx`, as `OctoMark` does. `octoMarkMotionGeometry.ts` derives transient,
command-compatible thinking frames from the main geometry; it is not a second
hand-drawn logo source. Generated PNG/SVG/ICO/ICNS files are outputs and must
not be edited by hand. The generator needs macOS (AppKit and `iconutil`).

`pnpm check:app-icons` runs the checker's unit tests, then the checker. Besides
sizes, alpha and optical bounds (measured over the body ink and the node
colors together, since the nodes are the mark's outer extremes), it samples
every crew asset's four node centers for their slot colors in order, rejects
any stray hue, proves the one-ink assets (favicons, the GitHub badge, the
Android themed layer, the iOS 20 pt@2x slot) carry no crew color, requires
`icon.svg` to draw the canonical geometry at the full-bleed fit it derives from
that geometry's own ink box, tells full-bleed from the distribution scale by
the ink box in every favicon entry, requires every node of each full-bleed
raster to read as ink (its center pixel at least half ink) and the raster
itself to match a reference rendering of the canonical geometry per pixel, within a
tolerance (which a redraw of nearly the same ink box, or a mark one pixel off
center, fails), and requires the crew colors in
`packages/frontend/src/styles/tailwind.css` (`--crew-1` … `--crew-4` and the
`.dark` lift) to equal the icon config. It decodes every representation of the
desktop `icon.icns` (PNG and ARGB) and `icon.ico` (DIB and PNG) and applies the
same size, fit and color rules to each, on the body of the macOS grid for every
`.icns` slot, whose margins must be fully transparent; keeps the maskable icons
and Android adaptive foregrounds inside their circular safe zones; pins the iOS
AppIcon catalog's six entries (two slots, each in the any, Dark and Tinted
appearances) and the Splash image set's light and dark entries; requires the
iOS Dark icon to paint only the white body and the dark crew set on a
transparent ground, and the Tinted icon to be opaque, RGB, greyscale and one
ink; requires every reverse splash to be opaque dark canvas to its corners with
the dark crew set in the positive splash's place; checks the generated Android
launch grounds and the light and night launch themes; pins `theme-color` to
brand paper and the dark canvas per color scheme in `index.html`, its inline
script and `ThemeProvider`, and to brand paper in the manifest, never brand
ink; and treats any `<link>` whose `rel` includes `icon`, in any attribute
order, as a favicon that must be one of the one-ink files.

`packages/frontend/public/og-image.png`, the social card every page shares,
is generated too: `pnpm generate:og-image` (`scripts/generate-og-image.mjs`)
renders `scripts/og-image/card.html` in headless Chromium at 1200×630 and
writes it as an opaque RGB PNG (some unfurlers composite a transparent card on
black). The card is the landing hero, cropped: marketing paper with a flat
header band and the hero's dot grid below it; the header lockup in the `crew`
colorway, drawn from the canonical geometry at 80 px with a 50 px `Instafy`
wordmark, and `instafy.dev` in slate on the wordmark's baseline at the right;
the all-ink headline and the sub copy, whose first glyphs share one optical
left edge with the mark's leftmost node; and the studio window reduced to a
plain white slab, its ledge, running off the bottom edge, with Cub on its
corner and his crew ink on the ledge. The ink is the card's color: in a feed it
is what catches the eye, so the window gives up its title and roster to leave
it room. Cub is drawn by the shipping engine with the landing's theme, perch
tuning and timeline, run live on the generator's paused fake clock: booped 7 s
after he boots and shot 1.25 s later, when the four splats have landed in logo
order and he looks at them with both eyes open. The splats are the engine's own
(its keep-outs keep them off the lockup, the domain, the headline and the sub
copy); none are drawn by hand. A 2 px warm hairline frames the card so it keeps
an edge on white feeds.
Its mark box is 80 px on the card, about 33 CSS px in a 500 px wide unfurl,
which the high-density screens that show unfurls draw at 1.5 to 2 device pixels
per CSS pixel: the `crew-hidpi` rule. Smaller previews (Slack and iMessage at
300 to 360 px) take the box below 28 CSS px; the card keeps its crew dots there
as an accepted exception, since it is one raster for every size. The square
crops some chat apps take cut the lockup and Cub; every page asks for
`summary_large_image`, so X keeps the full card.

Fonts come from the pinned `@fontsource/inter` devDependency and the script is
bundled from the frontend's sources, so nothing is fetched and two runs on one
machine write identical bytes (a different Chromium build may move pixels).
The generator also points every reference at the card's content-versioned URL
(`/og-image.png?sha=<first 12 hex of its SHA-256>`) so unfurlers drop a cached
older card: the two meta tags in `packages/frontend/index.html` and
`SOCIAL_CARD_IMAGE` in `packages/frontend/src/utils/seo.ts`, which every page
passes to `applyPageMeta`. `pnpm check:app-icons` checks the card's 1200×630
RGB shape. The frontend unit suite (`src/utils/__tests__/socialCard.test.ts`,
run on every pull request) checks that both meta tags and `SOCIAL_CARD_IMAGE`
match the committed file and that no other frontend source (`src/` and
`hosted/`) spells the path. The headline and sub copy in
`scripts/og-image/card.html` repeat `LandingHero.tsx`. Regenerate the card with any change to
the mark, the crew colors, the hero copy, or Cub's drawing or perch; its new
digest needs the public boundary policy's approval like every binary asset.

After changing geometry, color treatment, or distribution scale, run:

```sh
pnpm generate:app-icons
pnpm generate:og-image
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
visible viewport; themed icons are intentionally OS-recolored, from the
dedicated one-ink `ic_launcher_monochrome` layer. electron-builder takes the
generated `icon.icns` and `icon.ico` as they are, so their one-ink 16 to 32 px
representations are what Finder, the Dock's small sizes, Explorer and the
taskbar show; the `.ico` keeps classic 32-bit DIB entries under 256 px and one
PNG-compressed 256 px entry. Linux builds still derive their sizes from the
1024 px `icon.png`. On macOS 26 the system also refits legacy icons into its
own icon shape and adds its glass treatment, so the grid mostly matters on
macOS 11 to 15, which draw the `.icns` as it is; a full-bleed tile there was
about 24% larger than its neighbours. The iOS catalog is the single 1024 px
icon plus the explicit one-ink 20 pt@2x slot, each with its Dark and Tinted
appearance; Xcode derives every other size, all of them 58 px or larger, from
the 1024 px image of the current appearance.
Native launcher or desktop-icon changes require a new binary, and iOS uploads
require a unique build number. Google Play listing and developer-profile
artwork are separate manual console uploads today. GitHub App and OAuth App
settings also require a manual upload of the transparent, sub-1 MiB
`packages/frontend/store/github-app-badge-logo.png` plus the badge background
color `#0F172A`; each distinct registration must be updated separately. See
the relevant platform's release documentation for build and upload steps.
Private distributions should keep their signing and promotion runbooks outside
the public core.

## Authentication emails

Auth emails use a single white column, left-aligned text, and Arial/Helvetica sans-serif
throughout. Keep the sender name quiet, use one heading, and give the verification code or
underlined action link clear spacing. Codes use the same sans-serif family as the body.
Avoid nested cards, code panels, uppercase category labels, decorative borders, and remote
fonts or images. Use the brand interaction blue for links and readable 16px body text.

The source templates live in `supabase/supabase/templates/`. The confirmation, sign-in, and
reauthentication emails expose the code as selectable text without a confirmation link;
recovery, invite, and email-change messages retain their confirmation action. Do not hardcode
token length or expiry copy, because self-hosters configure those values. Local template changes
do not update a hosted Supabase project's dashboard configuration.
