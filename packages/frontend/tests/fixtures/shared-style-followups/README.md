# Shared style follow-up review

The sibling `style-followups-settings`, `style-followups-controls`, and
`style-followups-automation` fixtures render production components with inert data
boundaries. Each fixture documents its scenarios and interaction checks. They do
not replace authenticated integration tests or physical-device keyboard tests.

`createStyleReviewConfig` shares the environment-free CI UI server configuration.
For a before/after comparison, copy the frontend `src` directory before editing,
then start a second fixture server with `INSTAFY_REVIEW_BASELINE_SRC` pointing to
that copy and a different `--port`. The same fixture inputs and module identities
are used for both versions. The baseline must be trusted local source; it is not
committed or downloaded at runtime.

Review at 390px with a coarse pointer and 1440px with a fine pointer in both light
and dark themes. Include 320px, narrow embedded panes, short editor viewports,
pending requests, failure recovery, keyboard focus and dismissal. Wait for fonts
and fixture image decoding before capturing.

Use viewport screenshots and scroll to capture lower sections separately. In some
Chromium versions, a full-page capture taller than the viewport resets touch
emulation and changes the rendered control density. Assert pointer media and touch
target sizes before and after screenshots; a screenshot is not evidence of touch
layout if the capture changed the input mode.
