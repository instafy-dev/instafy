---
---

The eval's `reply_card_exists` check no longer fails a reply that says plainly there is no card ("no preview card was opened", "there is no card to open", "sin tarjeta"). It now reads the reply sentence by sentence and counts a sentence as pointing to a card only when it does not say there is none. No package changes.
