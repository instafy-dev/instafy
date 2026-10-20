---
"@instafy/cli": patch
---

Add `instafy preview open|list|close`. `open --port N --title T [--path P]` shows a site running in the space as a private "Ready to preview" card in the conversation, which only space members can open. It never prints a URL; its JSON output has `previewId`, `title`, `port`, `path`, `status`, `messageId` and `viewerHostSuffix`. Exit codes: `2` nothing answers on the port or the site answers with a server error, `3` the port is not allowed, `5` previews are not available on this server (nothing is downloaded or started and no card is posted). A preview whose client cannot start is closed again on the server. `instafy tunnel stop` and `instafy preview` now signal a recorded process only while it is still the rathole client for that tunnel's config, and `instafy tunnel start` reports a rathole binary that cannot be started instead of crashing.
