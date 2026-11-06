---
"@instafy/cli": patch
---

`instafy preview check` no longer records a picture it could not take (a blank page, one that never said it was ready) as the site's last picture. When Octo's own check after a change keeps no picture, the card still has its picture of the site from before the change, so the check Instafy runs at the end of the turn looks at the site again, and the card takes a new picture or drops the old one.
