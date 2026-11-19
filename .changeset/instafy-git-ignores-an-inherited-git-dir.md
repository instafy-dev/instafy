---
"@instafy/cli": patch
---

`instafy git` works in the space's `.instafy/.git` even when it inherits the variables git sets for another repository. git exports GIT_DIR, an absolute path in a linked worktree, to a `git rebase --exec` command, a `!` alias and every hook, and GIT_INDEX_FILE to a commit hook, and `instafy git add` or `instafy git commit` run from one staged into that repository's index, leaving it pointing at objects only `.instafy/.git` has. The variables git sets for `.instafy/.git` itself, as in its own hooks, still apply. `instafy runtime start` no longer passes those variables to the runtime agent, as a process or in its container, so the agent's git works in the space's workspace too. `-c` settings that arrive in GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT still apply.
