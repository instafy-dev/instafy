# Settings navigation and surfaces

Settings pages use `SettingsShell` so their navigation follows the available content width,
including when Studio has another panel open.

- Wide pages show a category list beside the form.
- Compact pages with up to three flat categories show visible tabs. Credits and Skills use
  this pattern.
- Larger or nested category sets use one anchored picker. A parent with children opens the
  next level inside that same picker. Back returns to the parent list; selecting a destination
  closes the picker and changes the route. Browsing categories does not add history entries.
- Escape and native Back return one level, then dismiss the picker. Keyboard focus returns
  to its trigger on dismissal and follows the selected category when the layout changes.

Your settings has Profile, Appearance, Notifications, Preferences and Advanced categories.
Appearance owns the device's System/Light/Dark theme; Preferences owns assistant file-saving
behavior. Theme changes apply immediately. Team and space colors remain in their scoped
identity settings. On mobile the five categories use the shared anchored picker.

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

On desktop, `StudioDesktopHeader` keeps the team avatar, space picker, workspace tabs and
Search button on one 52px row (64px for coarse pointers). Tabs overflow horizontally rather
than wrapping or compressing their titles. New chat stays in the sidebar, and the profile
menu stays in the organization rail. The header's left column shares the expanded navigation
width, including at narrow desktop sizes, so tabs never extend over that sidebar. Keep the
column when navigation collapses to preserve usable pickers; subtract native window-control
insets within it rather than shifting the tabs. Mobile retains its context and navigation rows.
The mobile workspace and navigation drawer share header padding and breadcrumb spacing, so
opening navigation keeps Home, team and space identities at the same leading positions.

The space picker uses the same compact list on desktop, mobile and inline navigation. Each row
has a small identity icon, a name, an optional unread count and a trailing current-space checkmark.
Recent spaces stay alphabetically ordered; **Browse all spaces** remains below the list.

Search expands into the same header when activated, temporarily hiding the tabs and revealing
the existing scope chips and full-page results. Cmd/Ctrl+K opens or refocuses it; Escape returns
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

Use a small, consistent radius scale: 6px for compact search scope chips, 8px for menu rows
and segmented options, 12px for navigation rows, form controls and profile actions, and 16px for cards, dialogs and
popovers. Human avatars remain circular; team identities use rounded squares. Do not turn
every action into a pill.

Compact category navigation and single-choice settings share the same segmented selector
styles: a quiet group with 12px corners, 8px options and one filled selected option. Hover
changes text contrast without looking selected. Keyboard focus outlines the label using
React Aria’s focus-visible state; pointer clicks must not draw a second frame around the
whole option. Share these styles through `segmentedControlStyles` while preserving each
control’s meaning: category navigation uses `aria-current`, and value choices use
`aria-pressed`. Keep category routes and immediate preference updates independent.

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
connection. Keep quota exhaustion or service unavailability distinct from the chosen default.
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
initials; the accent still identifies the selected team in its rail marker. In the header,
keep color on the identity itself, without a second tinted tile around the avatar. Search
scope chips use the same neutral surface for teams and spaces. These colors adapt to light
and dark mode. Home uses a small selection marker rather than a colored logo background;
the mobile context and navigation rows share one neutral surface, separated from the page
by a single divider. Keep workspace surfaces, primary
actions and notification counts on their existing semantic colors.

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
the path has its own row. Desktop layout follows Studio's 900px breakpoint; touch targets
grow independently for coarse pointers. Navigation selection uses a flat fill with a
separate keyboard-focus ring. Changes uses the shared segmented selector for Files/All
changes. Participants is an overlay, so it keeps its shadow while model/reasoning actions
have 44px targets on narrow screens and coarse pointers.
