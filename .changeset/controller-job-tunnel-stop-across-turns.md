---
---

An agent job can now stop a tunnel that an earlier job started on the same runtime generation. Every agent turn runs as a new job, so `instafy tunnel stop` from a later turn used to fail with 401 "job token cannot revoke a tunnel created by another job" and told the agent to sign in. Tunnel revoke now follows the rule preview close already uses: any live agent job on the tunnel's runtime and lease may stop a tunnel that carries the controller-owned agent-job marker for that runtime. A tunnel without the marker (started by a person or by the runtime itself), or one whose marker names another runtime or lease, is refused with 403 instead of 401. Members' and runtime machines' revokes are unchanged. No package changes.
