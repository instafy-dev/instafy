---
"@instafy/cli": patch
---

New `instafy preview check --port <port> [--path <path>] [--phone]` looks at a site served on this machine before anyone sees it. It loads the page in a headless Chromium, framed on another local origin, and lists its title, console and page errors, failed requests, and a blank page or a refused frame. It writes desktop and phone screenshots (`--out <dir>`) and supports `--json`. It is local only and downloads nothing: it uses a Playwright that the workspace or the system already has, and exits 4 ("nothing was checked") when there is none. Exit codes: 0 no problems, 1 problems found, 2 nothing is listening, 3 the port is not allowed, 4 no browser, 64 bad options.
