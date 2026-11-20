---
"@instafy/cli": patch
---

`instafy web search` without a search key no longer carries a key card (`offer`) or a line about one: its `no_provider` answer says only how to go on without a key. A turn asked for a score put the card it carried into its reply. The card now comes from `instafy web search-key --json`, which Octo runs only for a person who asks to set up search: the `request_secret` action for the key a search tries first, with its provider's words and the searches a day its entry allows. It reads the provider list built into the CLI, as a search does, so it works in every space, and a provider the space switched off is skipped.
