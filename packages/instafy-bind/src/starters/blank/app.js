/* Blank starter: the theme and site.js only, for anything the other starters don't fit (a quiz, a calculator…).
 * Build the page here with site.h (text always via textContent) and the theme's few patterns: .card, .list,
 * .field, .seg, .btn (at most one .btn.primary), .trust for any fact, .notice, .empty. Keep theme.css and site.js.
 * Keep view state in the query (site.state / site.setState) and give rows ids, so shared links and Studio's
 * Present / Follow show the same view.
 * SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  "use strict";
  site.start({
    data: null,
    render: function () {
      site.head({});
      var list = document.getElementById("list");
      list.replaceChildren(site.empty("Nothing here yet.", null, "Ask in chat to build this page."));
    }
  });
})();
