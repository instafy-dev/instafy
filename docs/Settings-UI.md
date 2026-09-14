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

Simple forms use `SettingsFormLayout`: a bounded reading width on the page surface, with
spacing between sections and outlines on individual controls. Profile, personal preferences
and team profile share this layout. Reserve cards for distinct collections, summaries,
warnings or other content that needs grouping; do not wrap an entire ordinary form in a
second rounded surface.

Compact category controls are at least 44 pixels tall. Shared menu items also use a 44-pixel
minimum for coarse pointers while preserving desktop density. Popovers scroll within their
available height, with a stable background and space for keyboard focus indicators.

Check settings with long labels, both themes, narrow and wide containers, and keyboard
navigation. In particular, verify nested destination selection, dismissal, and resizing
without losing focus or creating extra route visits.
