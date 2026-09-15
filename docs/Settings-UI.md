# Settings navigation and surfaces

Settings pages use `SettingsShell` so their navigation follows the available content width,
including when Studio has another panel open.

- Wide pages show a category list beside the form.
- Compact pages with up to three flat categories show visible tabs. Personal settings,
  Credits and Skills use this pattern.
- Larger or nested category sets use one anchored picker. A parent with children opens the
  next level inside that same picker. Back returns to the parent list; selecting a destination
  closes the picker and changes the route. Browsing categories does not add history entries.
- Escape and native Back return one level, then dismiss the picker. Keyboard focus returns
  to its trigger on dismissal and follows the selected category when the layout changes.

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
spacing between sections and outlines on individual controls. Profile, personal preferences
and team profile share this layout. Reserve cards for distinct collections, summaries,
warnings or other content that needs grouping; do not wrap an entire ordinary form in a
second rounded surface.

Use `Field` for persistent labels above controls. Default labels are 13px medium-weight
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

Use a small, consistent radius scale: 6px for compact search scope chips, 8px for navigation
and menu rows, 12px for form controls and profile actions, and 16px for cards, dialogs and
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

## Team identity

The space segment of the organization/space breadcrumb uses `SpaceIdentity`, including
the saved picture, icon and color, on both desktop and mobile. It follows confirmed appearance saves
and falls back to the chosen emoji, then initials, when a picture is removed or unavailable. Draft choices remain confined to the editor until
saved; a missing current space shows the Choose space prompt without a stale identity.

People, teams and spaces share `IdentityPhotoButton`: a labeled photo button with a pencil
badge opens the native file picker. People stay circular and team/space pictures use rounded
squares. Removing a space picture preserves its fallback icon and color. Space uploads are
previewed locally until Save appearance; Cancel discards the draft. Team uploads retain their
existing immediate-save behavior and do not discard unfinished name/color edits.

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
initials; the accent still identifies the selected team in its rail marker and breadcrumb
background. These colors adapt to light and dark mode. Keep workspace surfaces, primary
actions and notification counts on their existing semantic colors.

Color choices have 44px targets, native radio keyboard behavior and a selected border, so
selection does not depend on hue alone. The selector preview reflects unsaved name and color
edits. Save profile persists those changes; existing picture upload behavior is independent.
Only owners and admins can update team identity. Personal and existing teams without a
chosen accent use neutral styling.

The controller accepts optional `accentColor` on organization creation and profile updates,
and returns it in organization summaries. Omitted updates preserve the value; explicit
`null` clears it. Idempotent creation preserves an existing organization's saved color.
Apply the additive `20260914180000_org_accent.sql` migration before enabling color writes.
Older clients remain compatible and organization reads tolerate an unmigrated database;
the database and controller both reject values outside the palette.
