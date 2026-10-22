---
"@instafy/cli": patch
---

`instafy bind serve` now saves the data files it writes for clicks (records and `data/version.json`) when the site is in an Instafy space. It commits exactly those files to the space's checkout a couple of seconds after its last write and when it stops, under the origin's workspace lock, and the space's next save publishes them. Before, those writes had no owner, so a stopped space kept them as unsaved work and Studio showed "Some work wasn't saved" to everyone. Files someone else changed are left alone, and outside a space (a plain folder or your own repository) nothing is committed. `--no-save` turns it off.
