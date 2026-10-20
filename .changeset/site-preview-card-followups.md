---
---

Site preview cards: the controller no longer stores an Open action that nothing handles on a "Ready to preview" card, and it reports a preview's recorded visibility on `GET /previews/:id`. Studio says "Only space members" only when that visibility says so, reads an unprobed preview as Checking in both the card and the pane, keeps an ended preview tunnel's status (without its address) so a card still says Stopped when it cannot ask again, keeps a tunnel apart from its runtime's own only when the controller marks it, and lets one card per preview follow the site instead of each card asking on its own. No package changes.
