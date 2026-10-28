# Settings navigation and surfaces

Space settings include **AI helpers → Concurrent helpers per task**. It shows the
controller's native subagent limit, excluding the parent agent, separately from shared team
worker capacity. Only space managers can save a change; other members can inspect the value.
Saving updates this field only. Running tasks keep their limit and later jobs receive the
new value. Older controllers show an unavailable explanation instead of an editable default.

## Shared component contracts

Screens own arrangement: widths, grid/flex placement, gaps, wrapping and truncation.
Shared components own typography, palettes, corners, interaction states and touch targets.
Use an existing appearance prop before supplying color, padding or font overrides. Repeated
visual overrides in two or more real consumers are a reason to improve the shared component.
Do not rely on the order of Tailwind class strings to override a preset; generated CSS order
determines the winner. Arbitrary layout classes remain supported.

- `Button` and `IconButton` adapt to the primary pointer: fine pointers keep compact
  sizes at every width; coarse pointers keep at least 44px targets. Resizing a desktop
  window alone does not enlarge its buttons. `variant="text"` is the inline action treatment. Quiet actions (`ghost`, `outline`, `text`) use `tone`
  (`neutral`, `muted`, `accent`, `danger`) for their complete normal/hover/pressed palette.
  Filled actions keep their existing variants. `elevation="none"` removes decorative
  shadows from filled and outlined actions without removing their keyboard focus ring. Avoid nested color spans, `!text-*` workarounds
  and locally reconstructed destructive hover states.
- Prefer `Button preset="inline"` for contextual actions in notices and lists, and
  `preset="form"` for submit/cancel actions in forms. Both own 14px text, 12px corners
  and flat elevation. Inline uses 10px horizontal / 6px vertical padding; form uses
  14px / 8px. At the default font size they are 32px / 36px tall on fine pointers,
  including outlined variants; coarse pointers retain a 44px minimum target.
  Outlines replace 1px of vertical padding rather than increasing the height.
  Labels can wrap and increase height. A preset also supplies padding for a text
  variant; an unpreset text action keeps its existing unpadded inline treatment.
  Choose importance with `variant` and `tone`, and arrangement with layout classes.
  TypeScript rejects `size`, `radius` or `elevation` alongside a preset. Keep these
  individual props for specialized controls such as icons and chips; the presets
  do not change unconverted buttons. `SettingsFormActions` uses the form preset;
  invitation conflict and member actions share the inline preset with chat invites.
- Toolbar and dialog utility icons (Back, Close, Copy, Refresh, Expand and More) use
  the shared `IconButton` 8px corner default, usually with `variant="ghost"`.
  Keep the compact shared size and its 44px coarse-pointer target rather than
  fixing dimensions at a viewport breakpoint. Quiet actions have no permanent
  fill or border; hover/pressed surfaces and keyboard focus remain visible.
  Separate adjacent utility controls by 8px so their focus rings have clearance.
  Shape follows the control's context; primary or destructive importance comes
  from its variant/tone, not a circular shape or a locally reconstructed palette.
  Labelled contextual/form actions keep the inline/form presets above. Composer
  Send/Stop/Voice, standalone image-overlay dismissal, avatar badges, identity
  chips and compound tab controls retain their purpose-specific shapes.
  Browser address fields use the shared input's 12px radius, including the mobile
  address trigger. Their embedded Go/Clear utilities use the shared 8px corners.
- Image attachment previews use `AttachmentThumbnail`: 48px in the composer and
  96px in messages, with shared quiet-button interaction, 8px corners and no
  decorative border or shadow. The image supplies the thumbnail's content; it is
  not a file-type icon. Loading/unavailable states use the muted `Surface` and
  shared caption text. The composer tray uses `Surface tone="muted" radius="xl"
  shadow="none"`; its local classes only arrange and scroll the previews.
- Content-sized toolbar controls, such as participant stacks and a browser-location
  icon plus chevron, use `Button preset="toolbar"`. It owns flat elevation, 8px
  corners, 4px padding and a 32px minimum mouse target;
  the shared 44px minimum still applies to coarse pointers. Width grows with the
  contents instead of forcing a stack into a square. Use the quiet variant for
  these triggers. Avatars and ownership rings inside remain circular, and status
  badges remain informational. Take/Request/Give/Release control use the inline
  action preset; browser approval Allow/Deny use the form preset.
  Browser participant popovers use `Text bodyCompact` with primary contrast for
  names and `caption` with muted contrast for supporting status. Show Controls
  and Requested beside the corresponding person. The compact Give control action
  sits in the first requester's row; its accessible label retains the complete
  recipient name. Keep other controls in the footer and preserve request order.
  The composer's stash and queue triggers share `ToolbarCountButton`, built on
  this same toolbar preset: quiet when closed, with the secondary surface when
  expanded. Bookmark means stashed drafts; the numbered list means queued
  messages. Both have circular count badges, capped at 99+, with the exact count
  in their accessible label and tooltip. The opened queue visibly names
  "Queued messages" above the bubbles. Chat / Browser retain visible text labels.
  Triggers do not supply their own border, palette or size.
  Stash restore rows use the inline preset; their panel uses one solid surface
  and shared text variants. Delete, goal utilities, Collapse draft and Remove
  attachment use quiet utility icons with 8px corners. Goal actions move onto
  their own row in a narrow pane, preserving readable summary text and touch
  targets. Browser page chips use the inline preset with a neutral selected
  surface and quiet inactive actions. They retain their pressed/page-selection
  semantics and horizontal scrolling; they are not conversation navigation tabs.
- Composer action menus use `StudioMenuAction` for the shared menu-row presentation
  with button semantics inside their drill-in dialog. `StudioMenuItem` retains menu
  semantics elsewhere. Both share compact mouse / 44px touch rows, focus treatment,
  8px corners and `MenuItemContent` typography. Supporting descriptions use its
  description slot; utility icons are plain 16px icons, not nested bordered tiles.
  Shared separators reset the native rule border so only the themed 1px divider
  is visible. Popover scroll areas follow the selected theme's native color scheme.
- Slash-command and mention suggestions use `ComposerSuggestions` for the floating
  surface and native menu-row presentation. Labels and descriptions share the
  menu typography; mention avatars remain round. Lexical owns anchoring,
  highlighting, selection and keyboard focus, so these remain native buttons
  rather than a separate React Aria menu that takes focus from the editor.
- Browser location, session and sharing menus use shared menu actions, descriptions,
  text and separators. Session details retains its native disclosure behavior with
  the shared native-row presentation. Viewport bounds and native browser-overlay
  registration remain feature-owned. The composer's silence hint uses a quiet
  `IconButton` dismiss action with the shared 44px coarse-pointer target.
- Queue and saved drafts use `ComposerMessagePanel` for their 384px maximum measure,
  14px heading, 16px icon and 12px/8px header insets. `ComposerMessagePopover` owns
  viewport clearance and anchoring, leaving extra side room for queue dragging.
  The saved-draft list has one surface; the queue retains individual message bubbles.
  Their scroll limits remain distinct to suit a compact draft list and message previews.
  Queue drag previews use the shared floating surface and body typography.
- Stop and Take over confirmations use the small modal, responsive body gutters,
  bounded scrolling, subtitle/body typography and wrapping form-preset actions.
  The confirmation button remains distinct from its quiet cancel action. Their
  focus, busy state and browser-control permissions belong to the feature.
- `Input` and both native/styled `Select` share medium defaults and control size tokens.
  `Field label` plus matching `htmlFor`/control `id` also labels app-rendered selects;
  explicit ARIA labels remain authoritative. `Checkbox` owns its interaction target
  independently of the visible 16/20px box. Parent
  layouts must allow that target to grow on narrow or touch screens.
- Provider, credential and model pickers use `FormPickerTrigger` and `FormPickerPopover`.
  Their feature-specific choices and actions remain in each picker. Connect visible field
  labels using a trigger `id`/`htmlFor` or a label ID/`aria-labelledby`.
- Scrolling editors use `StudioDialogModal layout="editor"`, a `StudioDialogHeader`,
  `StudioDialogBody scrollable` and `StudioDialogFooter`. The shared shell owns viewport
  bounds and scrolling; callers may choose width and supply their form contents. Mobile
  full-screen editors keep their existing `ResponsiveDialogSurface` behavior.
- Use semantic `Text` variants for compact headings and descriptions rather than adding
  competing font-size/line-height classes. `InlineNotice` owns severity styling and accepts
  an `actions` slot. Its `density` selects compact or comfortable copy. Shared success,
  information, warning and danger colors come from the same semantic definitions.
- Use `SegmentedControl` for a mutually exclusive value. Reusing its CSS on separate buttons
  omits its radio-group and arrow-key behavior. Navigation tabs keep their navigation semantics.
  Like action buttons, segment sizing follows the primary pointer rather than the viewport:
  fine pointers keep compact 28px (`xs`) or 36px (`sm`) options at any width; coarse pointers
  get at least 44px targets. The group's surrounding padding adds 8px to its total height.
- Conversation view navigation uses the shared tab presentation presets, not radio
  controls. The `contained` preset owns 12px corners, 14px labels, 12px horizontal
  padding, a 44px minimum height and selected/hover/focus styling for composer
  tabs. The `underline` preset retains the header treatment. Tab owners keep
  panel selection, keyboard navigation, scrolling and close behavior.

The local component reference at `/tests/fixtures/component-system/index.html` runs against
the Vite dev server. It mounts production components with inert local state and no backend
session; it is not a product route or a production build entrypoint. Use it to inspect both
themes, widths, control states and a scrolling editor together. The component browser tests
`component-system-reference.spec.ts` and `button-appearance-responsive.spec.ts` check rendered
sizes, selection/focus, interaction palettes and pending states. Extend those contracts when
adding a shared variant rather than locking a one-off screen override into a test.

The companion `/tests/fixtures/control-surfaces/index.html` mounts the Files filter,
Appearance settings, settings footer and machine menu directly. Its callbacks are inert;
use it to review consumer alignment, wrapping and recovery actions. The
`control-surfaces-responsive.spec.ts` and `credential-entry-appearance.spec.ts` browser
checks cover mouse/touch targets at narrow and wide widths in both themes. These are
component checks, not authenticated backend or physical-device tests. The Machines example
uses its production `SettingsShell` at full available width, not a half-width comparison.

`SettingsShell width="comfortable"` caps a list/form surface at 56rem (896px at the default
root size), including its gutters. Skills and Machines use this option so controls stay near their
content on ultrawide screens. The default `wide` shell remains 72rem for other settings.
Both stay fluid below their cap and center within the available pane; extra viewport width
becomes margins, not larger fonts or indefinitely stretched rows.

### Spacing and width presets

Choose width by the task, not by the size of the monitor. A readable settings list uses
`comfortable` (896px including gutters); a denser settings workspace can use `wide`
(1152px including gutters). `SettingsFormLayout` limits a single form to 672px inside
that shell. The shell supplies one horizontal inset: 12px on narrow screens, 16px at
`sm+`, and 24px when the measured pane is wide enough. Chat's 896px content measure
excludes its outer gutters, so it is not the same box as a comfortable settings page.
Do not increase font sizes merely because a screen is wider.

For overlays, let the shared shell own the viewport clearance and use these presets:

- `StudioDialogModal size="sm" | "md" | "lg"` caps width at 384 / 512 / 672px.
  The default remains `md`. Pick the smallest size that fits the form; keep the
  shared safe-area-aware 16px minimum viewport clearance.
- `gutter="responsive"` opts an entire dialog into 16px horizontal padding below
  640px and 20px above it. Header, body and `StudioDialogFooter padding="default"`
  share that inset and use 16px vertical padding. The legacy default stays 20px
  horizontally, so unchanged custom sections do not become misaligned. Migrate
  header, body and footer together, removing their local padding classes. The
  footer remains unpadded by default for callers whose actions already own padding;
  `divider` adds a separator when fixed actions need that boundary.
- `StudioPopover layout="menu"` supplies 8px padding, a 6px trigger gap and 8px
  viewport clearance. Its 192px minimum width is clamped to the available viewport.
  `layout="form"` uses the same spacing and follows the trigger's width, also clamped.
  Explicit `offset` and `containerPadding` remain supported. Omitting `layout`
  preserves legacy geometry; do not apply menu padding around a rich form that
  already owns its inset.

The shared Select uses the form-popover preset; action menus in Chats, Automations,
AI connections and run controls use the menu preset. Listbox options, like menu items,
keep compact mouse rows and at least 44px touch targets. Keep feature-specific choice
contents in the caller rather than rebuilding menu geometry there.
Select options use a checkmark for the current value and a separate keyboard-visible
focus ring. Disabled options belong to the owning Select's selection state, so neither
pointer nor keyboard interaction can select them. Avoid repeating the selected value
as helper text below a field; its trigger already shows that value.
Menu items and picker options use the same inset keyboard focus ring so scroll areas
do not clip it. AI connection Test, Replace and Make default use quiet actions; mobile
menus contain actions only, including Replace. Selecting Test closes the menu and
returns focus to its trigger. Testing progress and results stay in the connection row;
failure guidance wraps instead of relying on a hover tooltip. The Default badge also
belongs to the row, rather than a disabled menu item.

New-chat, recent-space, organization-context and compact-header action popovers also
use the menu preset. They retain their content-specific widths and navigation behavior;
the shared shell owns the padding, trigger gap and viewport clearance. Private-chat
selection and Invite use the bounded editor layout, keeping their existing preferred
widths. Agent profile header, body and footer share responsive gutters. When a footer
contains `SettingsFormActions`, retain its inset divider and action spacing instead of
adding another divider or a second padded action wrapper.

History confirmation stays a compact dialog with shared body spacing and semantic text;
Cancel remains the initial focus. Team settings errors and invitation conflicts use
`InlineNotice`, with recovery or resolution controls in its actions slot. Local loading
states use `LoadingStatus`; permissions and the scope of each recovery action stay with
the owning screen.

Browser permission prompts retain their in-pane overlay and focus behavior, while using
`Surface`, `Checkbox`, and responsive `StudioDialogBody`/`StudioDialogFooter` spacing.
Long destinations scroll with the body; Allow and Deny remain reachable in the footer.
Participant control decisions use the inline action preset and shared body/caption
typography. Keep identities and permission scope visible when those rows wrap.

Use `InlineNotice appearance="inline"` for errors inside an existing toolbar, sharing
popover or composer. It supplies the semantic icon and readable, wrapping text without
adding another bordered panel. Standalone recovery guidance uses the default panel and
its actions slot. Do not truncate actionable errors or make their explanation available
only in a hover tooltip. Recovery actions retain their existing permission checks,
destinations and pending behavior; shared presentation does not own that logic.

The `/tests/fixtures/browser-approval-feedback/index.html` review mounts the actual
approval, participant-control, handoff and recovery components with inert data. Its
required browser checks cover 320px, 390px and desktop widths in both themes, including
keyboard focus, pending decisions, long errors, touch targets and retry actions. These
are component checks, not proof of a live browser transport or provider connection.

Project invitations follow the same notice and action presets as team invitations,
including pending-role conflicts and prepared email invitations. Notification settings
use shared text and recovery notices while retaining their saving live region and
device-permission behavior. The notification prompt uses the shared surface palette;
its location and available width remain owned by the conversation.

Automation editors use the shared editor frame, responsive body/footer gutters and
`SettingsFormActions`. Schedule fields and weekday choices keep their own arrangement.
The phone editor retains `MobileFocusDialog`, so its keyboard-aware scroll area and
short-viewport footer behavior remain consistent with other focused forms.

Space-switcher utilities and shared local-tab controls use the same quiet utility-button
shape and 8px spacing as other toolbars. The remote keyboard's inline trigger is a
toolbar utility; its standalone floating trigger retains its separate shape. Navigation
rows retain their intentional 48px targets, and identity avatars retain their own shapes.
In a shared browser pane narrower than 360px, Release moves into More so the current
view mode stays readable. This uses the pane width, including panes inside wide screens.

The `style-followups-settings`, `style-followups-controls` and
`style-followups-automation` fixtures under `packages/frontend/tests/fixtures` exercise
these production components with inert data. Their READMEs document interaction checks;
the shared fixture guide covers accurate mobile/desktop before-and-after captures.

Secrets uses the comfortable page width and a plain, wrapping list. Recovery uses one
`InlineNotice` with its Retry action; agent choices keep a bounded scroll area within
the editor. Secrets and AI connection editors opt all shared sections into responsive
gutters. API-key forms keep Connect in a footer outside the normal scrolling body.
On phones these forms retain `MobileFocusDialog`, including its visual-viewport
handling, Back behavior and very-short-viewport fallback. The footer scrolls with the
form when there is too little room to fix both header and actions on screen.

`/tests/fixtures/menus-forms/index.html` mounts the production Secrets and Your AI
pages with local sample data, plus the shared Select. Its isolated browser suite covers
light/dark themes at 390, 1280 and 2560px, form drafts across viewport changes, local
save, provider Back, menu focus return and narrow error recovery. It does not connect
real provider accounts or verify native keyboards. Generate comparison screenshots
outside the source tree with `INSTAFY_REVIEW_SCREENSHOTS`; keep them as review artifacts.

`/tests/fixtures/dialogs-feedback/index.html` covers the additional dialogs, navigation
menus and member feedback with inert data. Its browser checks include short viewports,
long labels, scrolling, draft retention and keyboard focus. The Invite dialog remains
mounted beneath QR so closing each layer restores its trigger; only the active QR
dialog is exposed in the browser accessibility tree.

Keep work drawers resizable and mobile navigation thumb-reachable. Their current
280–560px work-drawer range, 16px rail-header inset, and 12px mobile-navigation body
inset serve different arrangements. Account for row hit-area padding when comparing
text alignment, and keep safe-area/keyboard handling in the owning shell. Avoid
introducing another wrapper merely to supply a gutter already owned by its parent.

Files mounts its rail header edge-to-edge. The path and filter rows own their 16px
horizontal inset, while the scrolling file body owns its own matching inset; the
toolbar no longer cancels a parent's padding with negative margins. This also applies
to the no-space and unavailable-controller views. Skills actions and the Machines
size, pin-agent and More actions menus use the shared menu preset above.

The local `/tests/fixtures/spacing-presets/index.html` review mounts these production
shells and the real skill-import form with inert callbacks. Its browser checks cover
390px touch and 1280/2560px mouse layouts in both themes, menu selection and focus
return, editor draft retention, short-viewport scrolling, and navigation-sheet
scrolling. This is component-layout coverage, not authenticated backend or device testing.

Machine menus and the Machines page share a role-based hierarchy: `bodyStrong` names
and headings with `primary` contrast, `bodyCompact` descriptions and instructions with
`secondary` contrast, and `sm` text actions (14px). Facts, IDs and timestamps stay 12px
(`caption` / `mono`). Row IDs and collapsed stats use `secondary` so they remain readable
on the selection/hover fill; supporting metadata on the plain surface uses `muted`.
Warnings keep the semantic icon and surface, with neutral readable prose; failures and
destructive actions keep the shared danger tone. Typography stays stable across widths,
and touch enlarges the hit targets rather than scaling the labels.
Details and fact labels align with
the machine name; the status dot stays in the gutter. Identifiers wrap below names
when space is tight rather than forcing a short name to truncate beside touch actions.
The Agents label follows the first chip row's text baseline, including when the group
wraps. Avoid fixed top padding or centering the label against the entire multi-row group.
Machine selection uses a neutral fill and checkmark, independent of expansion and the
runtime status dot. Start and Stop use the shared neutral button tone; Remove uses
danger. Reserve accent treatments for primary calls to action and links.
The neutral selection surface includes the whole header, including its disclosure and
action controls; each control retains its own focus and hit area. In pickers the name
selects a machine and the separate chevron opens details. On the Machines page the name
and chevron form one disclosure control; choosing a machine requires **Use this machine**
in its details. Start/Stop stay visible in the header, while More actions opens the existing
Remove confirmation. Inspecting a machine never changes the space's preferred machine.
Expanded machine details use alignment and spacing, without a divider or enclosing card.
Routine actions use the shared ghost button treatment; empty states remain plain content.
Machine icon actions use `size="sm"` and the shared 8px corner default: 32px on fine pointers and
44px on coarse pointers, including Close, Copy, Start/Stop, More and picker disclosure.
**Use this machine** uses the flat secondary treatment (`elevation="none"`) to stay
recognizable as an action. Once selected, it becomes plain **Selected machine** status
text and focus returns to the stable machine row.
Removal confirmation uses an explicit question and a danger-toned action, with no extra
box or shadow. Recovery keeps one semantic warning surface; subsequent errors are announced
inline within it rather than nesting more notice surfaces. The machine-size field retains
its outline, and floating menus retain elevation.

## Navigation

Settings pages use `SettingsShell` so their navigation follows the available content width,
including when Studio has another panel open.

- Wide pages show a category list beside the form.
- Compact pages with up to three flat categories show visible tabs. Credits and Your AI use
  this pattern.
- Larger or nested category sets use one anchored picker. A parent with children opens the
  next level inside that same picker. Back returns to the parent list; selecting a destination
  closes the picker and changes the route. Browsing categories does not add history entries.
- Escape and native Back return one level, then dismiss the picker. Keyboard focus returns
  to its trigger on dismissal and follows the selected category when the layout changes.
- When the compact picker or tabs already name the content section, keep the matching heading
  for screen readers without repeating it visually. Descriptions, actions and other section
  headings remain visible. Wide category lists retain the content heading beside them.

Skills has a single flat installed list without category tabs or an enclosing card. Its
heading and primary Connect a tool action share one toolbar; compact layouts shorten the
visible action to Connect. The adjacent More skill actions menu contains custom import,
refresh, and Restore defaults when the list is confirmed empty. A failed load has one
inline Retry action instead of another refresh control. External catalogs are not
advertised in this flow.

Workspace read failures share one compact status strip beneath the space header. A failed
Files, Skills or Changes/History read asks the shared availability owner to check the active
file origin; only a confirmed connection, access or unavailable-origin response replaces
the local recovery notice. Missing paths, invalid documents and operation-specific errors
stay local. A stopped compute machine alone does not mean files are unavailable.
The strip provides one Retry action, rechecks connection failures with bounded backoff,
and refreshes affected read views after recovery without replaying writes. Previously
loaded lists remain visible with a stale-data label; remote mutations pause while editor
and creation drafts remain editable. The state is scoped to the signed-in account, space
and file route, and never carries an outage into another space or Home/personal settings.

Your settings has Profile, Appearance, Notifications and Advanced categories.
Its header is account-wide on both desktop and mobile: **Your settings**, a return action,
and global search, without the previous space's breadcrumb or organization tint. Back returns
to the previous route, or Home when there is no in-app history. Team and space settings retain
their scoped context and search.
Appearance owns the device's System/Light/Dark theme. Theme changes apply immediately. Team and
space colors remain in their scoped identity settings. On mobile the four categories use the
shared anchored picker. There is no file-saving preference: every agent turn saves its files,
so the former Preferences category is gone and an old link to it opens Profile.

Advanced keeps Developer tools collapsed until opened. Its diagnostics action and Support's
diagnostics action open the same Studio-owned dialog for logs, build information, runtime
connections and layout overrides. No developer-mode preference is required. The account menu
keeps Your settings, Support, install/update actions when relevant and Sign out.

Utility pages such as Settings, Credits, AI and Machines share one temporary workspace tab.
Browsing a different utility replaces that preview; settings categories reuse the same Settings
tab. Chat and file previews each have their own slot. Italic titles identify previews. Double-click,
reorder, or choose **Keep open** from a tab's context menu or the mobile tab picker to retain it.
The keyboard context menu (Shift+F10 or the menu key) exposes the same action. Existing kept
tabs are never downgraded. Focusing, scrolling or visiting a tab again does not keep it open.

Editing a file or an explicit-save profile/identity form keeps its tab, including after saving.
Profile, team profile, space name and space appearance drafts survive panel/category changes
in account-scoped session memory. Cancel restores the saved values. Closing a tab does not
erase a retained identity draft; reopening its editor restores it. Reloading, signing out or
leaving Studio ends that memory lifetime, so save changes before doing so. Refresh and navigation
outside Studio warn while these drafts exist. No form drafts or credential values are written
to browser storage.

Complex agent, AI connection, automation, secret and skill-import dialogs keep their mounted
owner while open: navigation offers **Keep editing** or **Discard and leave**. Pending saves and
connection operations must finish before leaving. Immediate preference toggles do not create
unfinished drafts. New explicit-save editors should use `useStudioDraftState` for retained
non-secret fields or `useStudioNavigationProtection` for a guarded flow.

A kept utility tab remembers its last settings section within the current space. Back and
Forward still follow Router history and restore each visit's scroll position; the tab strip does
not introduce another history stack. Utility/file previews and retained form drafts are session
state, while chat-tab restoration continues to use its existing persistence.

On desktop, `StudioDesktopHeader` keeps the team avatar, space picker, Search icon and
workspace tabs on one 52px row (64px for coarse pointers). Search sits immediately after the
space picker within the context column. Tabs overflow horizontally rather
than wrapping or compressing their titles. New chat stays in the sidebar, and the profile
menu stays in the organization rail. The header's left column shares the expanded navigation
width, including at narrow desktop sizes, so tabs never extend over that sidebar. Keep the
column when navigation collapses to preserve usable pickers; subtract native window-control
insets within it rather than shifting the tabs. In conversation workspaces, mobile tools and
Settings use one compact title/context header.
Navigation stays on the left; More actions retains Back, Forward, Home and Search. Settings
keeps its category picker below that header.
On wide browser and Desktop layouts, drag an organization icon up or down in the left
rail to change its order. Home and the footer remain fixed. A short movement threshold
keeps normal clicks selecting teams; touch dragging starts after a brief hold so swiping
can still scroll the rail. Escape cancels a drag. The icon's context menu also offers
**Move up** and **Move down**, available with Shift+F10 from the keyboard. Reordering
keeps the current team and workspace active. Order is saved per signed-in account in
that browser or Desktop installation; it does not sync between devices. Newly joined
teams appear after the saved order.

The desktop space selector fits its icon, name and chevron with 8px horizontal padding.
Unused column width stays outside its hover surface; long names truncate within the column.
The mobile workspace and navigation drawer share header padding and breadcrumb spacing, so
opening navigation keeps Home, team and space identities at the same leading positions.

The space picker uses the same compact list on desktop, mobile and inline navigation. Each row
has a small identity icon, a name, an optional unread count and a trailing current-space checkmark.
Recent spaces stay alphabetically ordered; **Browse all spaces** remains below the list.
On mobile, browsing all spaces replaces the navigation sheet’s root toolbar with one Spaces
header: Back, Search spaces, current-space settings and New space. Back restores the root
toolbar and its chat actions; the two scopes do not show competing search/plus controls.

Search expands into the same header when activated, temporarily hiding the tabs and revealing
the existing scope chips and full-page results. It starts in the team and accessible space shown
in the header, including on Home and personal settings. A retained space from another team is
excluded. Remove the space chip to search the team, then the team chip to search all teams.
Cmd/Ctrl+K opens or refocuses it; Escape returns
focus to Search. The shortcut yields to modal dialogs and already-handled editor shortcuts.
The header clears Electron's window controls once; interactive descendants are excluded from
the window drag region.

The desktop working-context header owns one continuous divider across the navigation,
open drawers and workspace. Keep it in both themes and across panel and search changes.
Active tabs meet that edge without adding a second horizontal line underneath it; tab
overflow fades affect only scrolling content, leaving the shared divider visible.

Keep account identity in the avatar menu. Personal settings should not repeat an email above
their categories. Team and space settings retain their scope because it identifies whose
configuration is being changed.

On first use, a missing personal profile is initialized from the sign-in provider's
nonempty name, falling back to its username, plus its photo when supplied. Email addresses
are not turned into default public names. Initialization inserts without replacing an
existing row and rereads the saved result, so another tab's edit wins. Existing profiles,
including deliberately cleared fields, are never reseeded by login or provider changes.
Accounts with no supplied name keep an empty, editable Display name field.

Use `HumanAvatar` for human identities. A supplied photo takes precedence; otherwise show
initials on a muted color derived from the stable user ID. With no name, use the neutral
person icon. Color stays consistent through renaming and photo removal, and has a matching
light/dark palette. Do not derive initials from email addresses or generic labels such as
“You”. Chat, presence and member surfaces use the identity data their contracts supply;
some currently expose only a name and user ID, so those surfaces render the shared fallback
without a photo. Agent/Octo identities and shared-browser cursor colors retain their own
treatments.

Simple forms use `SettingsFormLayout`: a bounded reading width on the page surface, with
spacing between sections and outlines on individual controls. Profile, personal preferences,
team profile and space basics share this layout. Reserve cards for distinct collections, summaries,
warnings or other content that needs grouping; do not wrap an entire ordinary form in a
second rounded surface. The space name and appearance editors sit directly on this page
surface, with no enclosing `SettingsSurface`. Team and personal name/photo rows share
`SettingsIdentityRow`.

Explicit-save forms use `SettingsFormActions`: one quiet divider, a secondary Cancel action
and a primary Save action, with the same radius and touch targets. Save stays disabled for
unchanged, invalid or pending edits; Cancel restores saved values without writing. Space
name and space appearance remain separately saved sections. Enter submits the name form;
Escape resets its draft without dismissing the surrounding settings navigation. Personal
display names may be empty; team and space names remain required. Permissions remain
scope-specific: people edit their profile, owners/admins edit team identity, and writable
members edit space identity.

One-off operations use `SettingsActionRow`: one heading, one explanation and an action on
the page surface. At smaller widths the action moves below the explanation instead of
shrinking its label onto multiple lines. Managed defaults and device alert permissions use
this pattern. Notification categories use plain groups with quiet separators; invitation,
AI/voice and provider setup forms use the same field spacing as profile settings. Preserve
list cards and permission warnings where their boundary carries meaning.

Immediate on/off preferences use `Toggle`; use `layout="row"` for a full-width setting
with its label and description on the left and its switch aligned on the right. Choices
inside an explicit-save editor use checkboxes and apply only through Save. Secrets shares
the `SettingsFormActions` footer with the other editors, including mobile touch targets.

Notifications initially shows the current platform's delivery channel, four category
switches and the privacy preference. Other account-wide channels remain in a disclosure;
changing one switch updates only that category/channel. Device permission is displayed
separately from category preferences and is read without prompting on entry. Android
currently offers in-app preferences without a push-enrollment action; iPhone and browser
permission setup stays explicit. A failed setup must clear its pending status.

Use `Field` for persistent labels above controls. Connect `htmlFor` to the control's `id`;
text that only looks like a label is insufficient. Do not wrap secondary buttons inside a
label. Keep visible labels in automation, import and provider setup dialogs as well. Default labels are 13px medium-weight
secondary text; hints stay 12px muted text. A vertical layout provides an actual 8px gap
between label, control and helper text. Explicit extra-small fields keep a compact 6px gap.
The label should identify the field without relying on placeholder text; omit placeholders
that only repeat the label, such as “Add your name” under “Display name”.

`Input` and `Select` default to the medium form size: 16px text on narrow screens and 14px on wider
screens. Controls have a 44px minimum height on narrow screens or coarse pointers, and
a 38px minimum height on wider fine-pointer screens. Explicit small/extra-small controls
retain their compact sizing, and unstyled inputs retain their host layout. Preserve the
existing thin outline, 12px default radius
and visible keyboard focus treatment. Profile's Save action follows the same 44px mobile
target and uses a compact 36px height on wider fine-pointer screens.

Use a small, consistent radius scale: 6px for compact search scope chips, 8px for utility icon controls, menu rows
and segmented options, 12px for navigation rows, form controls and profile actions, and 16px for cards, dialogs and
popovers. Human avatars remain circular; team identities use rounded squares. Do not turn
every action into a pill.

Compact category navigation and single-choice settings share the same segmented selector
styles: a quiet group with 12px corners, 8px options and one filled selected option. Hover
changes text contrast without looking selected. Keyboard focus outlines the label using
React Aria’s focus-visible state; pointer clicks must not draw a second frame around the
whole option. Share these styles through `segmentedControlStyles` while preserving each
control’s meaning: category navigation uses `aria-current`, while mutually exclusive values
use a labelled radio group with one tab stop and arrow-key selection. `SegmentedControl` owns
that radio behavior; Appearance, Credits display options, Automation schedule/runtime and
Invite access share it. Multi-select weekday chips keep `aria-pressed` instead.
Use checkboxes for Automation choices that remain drafts until Save, and say when they apply.
Keep category routes, immediate preference updates and explicit form saves independent.

In the personal profile form, keep the circular photo and Display name beside each other,
including on narrow screens. The photo is a labelled button with a pencil badge that opens
the image file picker; do not expose a separate image-URL editor. Show Remove photo only
when a photo exists. Uploads and removals remain previews until Save profile is pressed.

People and bots have an optional **About** field using `ProfileBioField`: a persistent label,
plain multiline text, a 500-character counter and a validation error for longer text. Count
Unicode code points consistently with the database. Save and clear it explicitly with the
profile. Bot **Style guidance** remains a separate field and keeps its existing runtime
meaning; a public bio must not become an instruction. Profile cards fetch current public
fields in the selected space and preserve saved empty values. They must not show email,
credentials or bot instructions, or reuse a previous account/person's response.

Compact category controls are at least 44 pixels tall. Shared menu items also use a 44-pixel
minimum for coarse pointers while preserving desktop density. Popovers scroll within their
available height, with a stable background and space for keyboard focus indicators.

Check settings with long labels, both themes, narrow and wide containers, and keyboard
navigation. In particular, verify nested destination selection, dismissal, and resizing
without losing focus or creating extra route visits.

## Your AI

Keep **Connections** and **Agents** as separate categories inside Your AI, using the same
responsive `SettingsShell` navigation as other settings. Connections choose what powers
new prompts; agents customize identity and instructions and may choose their own connection.
Opening an agent profile from a conversation selects Agents, so closing the editor returns
to its list. Switching categories keeps the connection and agent state mounted.

Use the shared `SettingsAddButton` for the **New agent** action, matching Connections.
Keep it visible even when no personal AI connection is saved. Agent profiles can
be created before connecting AI; the controller already accepts a null credential with an
explicit handle. Require that handle in the editor, leave the model unset, and explain whether
the profile will use managed AI or needs an AI connection before chatting. Do not present a
list of disabled providers when no personal connections exist.

After the controller confirms its capabilities, show Instafy AI as the first connection row with
the canonical Octo mark, its allowance and the same Default badge or Make default action
as saved providers. Selecting it clears the default credential without deleting any saved
connection. Keep quota exhaustion or service unavailability distinct from the chosen default:
Instafy AI is available or not whichever connection is the default, and when it cannot run turns
the row says why in plain words (today's prompts are used and when more come, the server is not
set up to run it, or it cannot be reached). Make default is offered while it can run turns or only
today's prompts are used. Adding a connection from this page never takes the default from an
available Instafy AI; connecting from chat ("Connect your own AI", the AI gate) is the person's
choice of AI and does.
Controllers without managed AI show "Unavailable on this server" without a Default badge,
quota or switch action. An unresolved or failed capability check must not be presented as
confirmed unavailability. Reserve the separate status summary for loading, errors or a saved
account that needs to be selected as default.

Show supported connection methods directly under **Connect an account**, after saved connections,
even when the account has no connections yet. The page and existing connection chooser share
`CredentialsConnectionChoices`, including Desktop's local Codex option. Selecting a row opens
that provider's setup directly; Back or Close returns to the same page without another chooser.
Provider selection alone never creates a credential or changes the default. Existing connection
verification, default selection and replacement behavior remain owned by `useCredentialsConnectFlow`.

## Team identity

The space segment of the organization/space breadcrumb uses `SpaceIdentity`, including
the saved picture, icon and color, on both desktop and mobile. It follows confirmed appearance saves
and falls back to the chosen emoji, then initials, when a picture is removed or unavailable. Draft choices remain confined to the editor until
saved; a missing current space shows the Choose space prompt without a stale identity.

People, bots, teams and spaces share `IdentityPhotoButton`: a labeled photo button with a pencil
badge opens the native file picker. People and bots stay circular and team/space pictures use rounded
squares. Removing a space picture preserves its fallback icon and color. Space uploads are
previewed locally until Save appearance; Cancel discards the draft. Team uploads follow the
same draft behavior: name, picture and color save together through Save profile. Cancel
restores the latest saved identity, including updates received while editing. Uploads are
validated before preview, and a failed metadata save can retry its uploaded URL.

Team and space uploads accept PNG, JPEG and WebP up to 2 MB. They use the public
`identity-images` Supabase Storage bucket with immutable random filenames; these pictures
are public display assets, not private workspace files. Only owners/admins upload team
pictures. Space owners, builders and inherited writable team members can upload space
pictures. The controller rechecks metadata write access, validates picture URLs and returns
`projectAvatarUrl` in space summaries; omission preserves it and null removes it. Network
URLs are persisted, while local preview blobs never enter workspace metadata.

Apply `20260915100000_identity_images.sql` before enabling picture writes. It adds the space
image field and provisions the bucket's size/MIME limits and upload/delete policies. For a
controller-only database without Supabase Storage, metadata migration still succeeds with
an explicit notice; install Storage and rerun that migration to enable uploads. HTTPS
image URLs remain supported. HTTP image URLs are allowed only under the configured Supabase
public identity-image storage origin, so local/self-hosted previews work without relaxing
external image URL validation.

Right-click a team icon in the desktop organization rail for Team overview, Team settings
and Members. Shift+F10 or the keyboard menu key opens the same anchored menu; Escape
dismisses it and returns focus to the icon. Actions target the clicked team, including
teams with no spaces, without first switching the active space. The mobile header's team
menu remains the visible touch entry point.

Team profile settings and new-team onboarding offer a shared color alongside the name and
picture. Use `OrgIdentity` for team avatars and `TeamAccentPicker` for the fixed palette:
neutral, blue, violet, pink, red, orange, green and teal. A picture takes precedence over
initials. In the header,
keep color on the identity itself, without a second tinted tile around the avatar. Search
scope chips use the same neutral surface for teams and spaces. These colors adapt to light
and dark mode. Home uses a small selection marker rather than a colored logo background;
the mobile context and navigation rows share one neutral surface, separated from the page
by a single divider. Keep workspace surfaces, primary
actions and notification counts on their existing semantic colors.

In linked desktop navigation, the selected team, inner sidebar and header form one flat
neutral surface. Keep the outer organization rail a distinct darker shade in both themes
so the curved connection stays visible; identity color remains on the avatar. Surface
values belong to `StudioContextLayout.css`, and notification badge rings inherit the
surface beneath them. The selection marker and keyboard focus remain separate cues.
Home, account and search omit the selected-team bridge and use one neutral navigation
surface. They retain the same desktop content frame: a 1px divider and 14px top-left
corner, with the vertical divider beginning below the curve. Its horizontal location
follows the visible navigation width (224px expanded, 64px collapsed, 0px hidden) after
the 64px organization rail. Mobile does not use this desktop frame.

Content and toolbar boundaries have one owner:

- The shell owns the content frame, including its curved corner. Pages and
  unavailable/empty states inside it remain flat, without a second outline.
- Page content, docked panes and Search use the same working-surface fill.
  Navigation uses its separate neutral surface; do not use a page fill to
  communicate selection or loading state.
- A toolbar can own one bottom divider above the content it controls, especially
  when that content scrolls independently. The content below must not also add
  a top border at that same boundary.
- Rows of controls belonging to one toolbar use spacing and alignment instead
  of an internal rule. Separate panes, repeated list rows, diff-file headers and
  diff hunks can retain meaningful dividers.
- Embedded diff previews are flat. Standalone previews can own a single frame;
  nested preview components must use their embedded presentation.
- Inline content surfaces do not need elevation shadows. Reserve surface
  shadows for overlapping menus, popovers and dialogs. Selection uses a fill,
  text/icon treatment and an accessible focus indicator.

Use the neutral divider and panel helpers in `theme/darkSurfaces.ts`; do not
substitute slate-ramp borders or unrelated dark fills on one page. These rules
describe container boundaries, not input outlines or semantic warning borders.

On macOS Desktop, the outer organization rail reaches the top of the window and
widens from 64px to a 92px cap around the native window controls. The cap's shoulder
and its inward turn at the window's top edge use the workspace's shared 14px corner
radius. The shoulder returns to the rail's normal width beside the first navigation
row. Center the traffic lights in the 52px desktop header and leave 16px between the
cap's straight edge and the first interactive header control, beyond the shell's
80px drag corner.

Mobile breadcrumb pickers keep a 48px tap target, but hover, open-menu and keyboard-focus
feedback follows a compact 32px shape around the content. Give text pickers 8px horizontal
padding so the highlight has breathing room beside the label as well as above and below it.

Color choices have 44px targets, native radio keyboard behavior and a selected border, so
selection does not depend on hue alone. The selector preview reflects unsaved name and color
edits. Save profile persists those changes together with the picture.
Only owners and admins can update team identity. Personal and existing teams without a
chosen accent use neutral styling.

The controller accepts optional `accentColor` on organization creation and profile updates,
and returns it in organization summaries. Omitted updates preserve the value; explicit
`null` clears it. Idempotent creation preserves an existing organization's saved color.
Apply the additive `20260914180000_org_accent.sql` migration before enabling color writes.
Older clients remain compatible and organization reads tolerate an unmigrated database;
the database and controller both reject values outside the palette.

## Bot profiles

Bot creation and editing use the same `SettingsIdentityRow`, persistent fields and
`SettingsFormActions` as personal profiles: picture beside Display name, then Handle and
About. Keep provider, credential, model and Style guidance in a separate Bot behavior
section. Changing a public profile must not pin or change inherited runtime defaults.

Bot pictures use the shared PNG/JPEG/WebP validation and 2 MB limit. Native file selection
creates a local preview; Save profile uploads and then saves the URL. Cancel discards the
draft, removal restores the bot's fallback identity, and failed metadata saves reuse the
uploaded picture on retry. Disable editing and dismissal during a save. Reset drafts on
account changes and do not save a completed upload into a different account's bot.
`AgentAvatar` renders the same saved or draft identity in the editor and bot list, including
the themed Octo mark and a fallback for unavailable images.

Apply `20260915110000_agent_identity_images.sql` after the identity-image migration. Bot
uploads use `agents/<owner-user-id>/<random-uuid>.<extension>` in the public `identity-images`
bucket, which also permits uploading before a new bot has an ID. Only that user can upload
or delete objects in their directory; overwrite is not allowed. The existing controller
checks bot ownership when saving `avatarSeed`. Existing saved image URLs remain readable,
but the editor uses the native file picker rather than an image-URL field.


Docked side panels use `DrawerHeader frame="rail"`: a 48px row with 16px horizontal
insets and a 16px semibold title. Keep path details and filters below that row so the
heading starts immediately below the shared desktop header. Loading fallbacks use the same frame.
Files keeps New file visible and groups New folder, Refresh and Collapse all under More;
the path has its own row. On desktop, folder rows expand in place and a separate
**Open folder** arrow enters the folder. On mobile the folder row itself enters it;
there is no second folder action. Back from a file keeps the list mounted so its folder,
filter and scroll position survive. File navigation retains unfinished edits (including
empty drafts); only an explicit reload requests replacement.
Opening a file shows the viewer immediately, including on mobile. Failed reads keep
Back and Retry available in the viewer instead of leaving the error behind the file list.

The file viewer uses a pencil for **Edit**, an eye for **Preview**, and **Source** for
read-only Markdown. These are content-sized shared controls, with no fixed-width override.
Preview and non-text viewers omit editor history actions. On mobile, Undo/Redo and the
legacy **Save draft** action live in **File editing actions**, keeping the filename and
main save action visible. Desktop editing exposes the labelled save actions directly.
Save draft writes to the workspace without creating a version; Save version also commits
and syncs that file. Versioned origins keep their single Save action. The footer reports
unsaved changes, saving and saved state; read-only viewers offer no save actions.
Viewer toolbar actions use the shared button tones and flat elevation.
The viewer footer keeps save status and size on one compact row. A quiet inline
**Details** action opens the full size, modified timestamp and MIME type in a shared
popover; unknown values are omitted. Status stays visible and can wrap when needed.
Use shared caption text and pointer-aware buttons, with the same 16px horizontal
inset as the header. The footer owns one top divider, without a separate surface
or shadow; only the floating details popover has elevation.

File viewers, diff-file headers and the All changes summary use `ContentHeader`.
These are content headings below the page navigation: 14px medium primary text,
12px regular muted supporting text, and a 16px muted decorative icon. They share
16px horizontal insets and 8px between the title, controls and individual actions.
This leaves 4px of clearance beyond the shared focus ring, which extends 4px outside
the focused button. Composed controls such as Undo/Redo participate directly in the
header's action layout instead of adding a tighter internal gap.
File toolbar controls use the shared Button/IconButton 8px corner radius. Back,
Edit/Preview and More are quiet actions, with no permanent fill or border. Save is
quiet when clean and primary blue for unsaved edits or known changes awaiting a
version, retaining its primary treatment while saving. Unknown legacy version
status stays quiet but actionable. A clean Save remains focusable and aria-disabled
so completing a keyboard save does not drop focus. Keep these states in the shared
button variants rather than local color, shape or padding overrides.
Default headers use 8px vertical padding; repeated diff-file headers use the compact
6px preset without changing their typography. Both retain the shared pointer-aware
button targets. Compact diff headers can use the subtle surface preset to distinguish
each file from its code; the header owns one bottom divider and no enclosing shadow.
Long filenames truncate while controls remain visible. Crowded controls wrap onto a
second row instead of squeezing the filename and supporting text; this follows the
available panel width, independently of the viewport or pointer. These content headings
use a plain container, not a page-banner landmark. File code remains monospace
with semantic diff colors. Keep titles, icon colors and padding out of consumer overrides.
In the mobile selected-diff sheet, Previous/Next use shared icon buttons with explicit
accessible names so navigation, Close, Open file and Refresh fit in one action row even
at 320px. Desktop keeps the labelled inline actions.

The path row and header use the shared spacing described above. Desktop layout follows Studio's 900px breakpoint; touch targets
grow independently for coarse pointers. Navigation selection uses a flat fill with a
separate keyboard-focus ring. Changes uses the shared segmented selector for Files/All
changes. Participants is an overlay, so it keeps its shadow while model/reasoning actions
have 44px targets on narrow screens and coarse pointers.
