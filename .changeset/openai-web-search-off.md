---
---

OpenAI's built-in web search is off for every kind of AI: Lite, a person's own OpenAI key and a ChatGPT login alike, on every runtime lane, as it already was for browser turns. The runtime sets Codex's web search to disabled and keeps its search features off whatever a Codex config file or `CODEX_ENABLE_WEB_SEARCH` asks for, and the AI proxy drops OpenAI's hosted search tool (`web_search`, `web_search_preview` and their dated forms, also inside a namespace or an `additional_tools` item) from every request on every lease, pinned or not; its default ChatGPT tools no longer include it. Octo will search only through Instafy's own command, which keeps the web-research skill's link-only sites link-only; OpenAI's search cannot. `CODEX_ENABLE_WEB_SEARCH` is retired. No package changes.
