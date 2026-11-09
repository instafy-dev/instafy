---
"@instafy/cli": patch
---

`instafy preview open --start` no longer needs `--serve-cmd` in a page's own folder: in `sites/<name>` of a space's workspace, with an `index.html` and no `package.json`, it starts Instafy's page server there (`instafy bind serve . --port {port} --preview`, on this machine only), the command `instafy bind card` already runs. Such a page reloads in every open view when a change to it is saved, and later turns list it among the space's pages; started by hand with another static file server, it did neither. Anywhere else `--start` still asks for `--serve-cmd`, and a `--serve-cmd` that is given runs as given. The error for a `--serve-cmd` with no `{port}` no longer suggests a command.
