---
"@instafy/cli": patch
---

Ask Octo works in Studio's preview pane. A bound site's `bound.json` agent intent may declare `say`, the words of the clicker's chat message (`"Is size {size} in stock for {ref}?"`), and the bind client sends `say` and `confirm` with an ask and waits while the host asks the person first (`ask-status` `confirm`). Studio tells the page whether this person may ask (`caps.ask`: true, or the plain reason a view-only member may not), sends a click as their own message in that conversation ("Is size 10 in stock for Karhu ikoni 3? · via Running shoes"), shows its own confirm strip only for `confirm: true` intents, keeps one ask at a time and six in ten minutes per person and site, and answers `sent`, `declined`, `done` or `failed`. The controller keeps `metadata.siteIntent` only when the sender may see that open preview, and Octo sees it as labelled page data in its prompt.
