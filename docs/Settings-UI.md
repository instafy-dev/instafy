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
popovers. Avatars remain circular and settings category tabs remain flat with an underline.
Do not turn every action into a pill.

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
