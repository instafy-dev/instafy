---
---

Studio keeps a tool's own work threads out of the way: a root conversation whose `metadata.source` names the tool that wrote it never opens a tab by itself, is never the chat Studio falls back to or lands in on first load, and is listed in Chats only under a new "Tool threads" filter (offered only when there is one) and not among the phone's loaded chats. A tool thread nested under a person's chat stays with that chat. On phones, an auto-hidden composer keeps its 12 px peek again: it is moved by its inline transform alone, because Tailwind 4's `translate-y-full` sets the CSS `translate` property, which adds to `transform` and pushed the whole composer off screen. No package changes.
