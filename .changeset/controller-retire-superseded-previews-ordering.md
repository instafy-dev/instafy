---
---

Closing previews whose broker tunnel was replaced now only closes grants recorded before the new one, so an open or a wake that got an older tunnel of the same key but finishes late can no longer close the newer preview. The new grant also forgets the card ids of every grant it superseded, not only the ones closed in the same call, so a wake that copies an old preview's cards after another open already closed it no longer keeps the new preview from posting its own card. No package changes.
