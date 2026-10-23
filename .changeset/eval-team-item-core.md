---
---

The eval's `team_items_on_site` check now counts a lane as shown when its label adds words to the lane's handle ("Tokyo Research" for `@tokyo`) and the page names the handle's item ("Tokyo"). Before, such a page failed with "not on the page: Tokyo Research, Kyoto Research, Osaka Research" although it showed all three cities. A handle that is not part of its label adds nothing. No package changes.
