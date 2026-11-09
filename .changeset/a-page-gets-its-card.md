---
"@instafy/cli": patch
---

`instafy bind card <dir> [--json]` takes the card step a check that passes takes, without the check: in a space, for a page whose card was never opened (the space's record of its pages doesn't hold it) while no preview shows its folder, it serves the page and posts its card, titled from the page as the check titles it (the same `instafy preview open --title … --serve-cmd "instafy bind serve . --port {port} --preview" --start` in the page's folder), and prints what that answered. It posts nothing for a page the record holds (another chat's page, or one whose card was opened before), one a preview shows, a folder that isn't one page, or a folder outside a space; it exits 0 when it posted the card, 1 when the card's command failed and 2 when there was no card to post. Instafy's runtime takes this step itself at the end of a turn that made or changed a page and left it without a card.
