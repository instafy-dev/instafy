---
"@instafy/cli": patch
---

The git credential helper matches the local stack's service names (`git-edge`, `git-shard`, `git-shard-<n>`) only as single-label hosts. A dotted host whose name merely starts with `git-shard` no longer gets a token.
