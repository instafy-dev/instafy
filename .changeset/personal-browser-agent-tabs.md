---
"@instafy/cli": patch
---

In the desktop app's Personal Browser, Octo can open up to three visible tabs of its own while you have resumed control, to read several pages in one turn: `list_tabs`, `open_tab`, `select_tab` and `close_tab` join its browser tools. Every tool acts on the tab on screen, Octo's tabs are marked in a tab row, each tab asks for its own site in Ask mode, and Pause, Escape or Take over ends Octo's control of every tab at once. Agent tabs open public web pages only: every page request in them, each redirect hop included, resolves its host and is refused when it is not public. `instafy web read` and agent tabs also treat a local host name written with a final dot, such as `localhost.`, as local.
