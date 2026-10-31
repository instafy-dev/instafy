---
"@instafy/cli": patch
---

`instafy preview check` can keep the picture for an open preview's card in a file instead of sending it, for Instafy's runtime to send with its own credential after a turn's reply (`--picture-to <file>`, hidden from help). A check that sends its picture records when it took it before sending it, so an older picture still on its way to the card is not sent after it.
