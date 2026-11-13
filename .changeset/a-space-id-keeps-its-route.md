---
"@instafy/cli": patch
---

A space id can no longer send a command's request to another route of the controller. The `conversation`, `chat`, `history`, `automations`, `agents`, `diagnostics` and `runtime start` commands accept a space only as a UUID, whether it comes from `--space`, `SPACE_ID` and the other space variables, or a folder's `.instafy/space.json`, which a cloned repository can commit. Anything else is refused before a request is sent, and the error names where the value came from. Before, a binding such as `../agent/plan-groups/<id>/status?x=` sent `conversation list`, `search` and `show` to that other route with your token: `list` and `search` reported an ordinary empty answer, and `chat` and `conversation create` would have posted there. Every id the CLI puts into a request path is now encoded, and since encoding leaves an id of `.` or `..` as it is, the CLI and `instafy bind` refuse a controller request whose path has such a segment.
