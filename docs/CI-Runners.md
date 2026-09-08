# CI runners

The workflow checks, job names, image platforms, permissions, protected environments and artifact
contracts are the same in both runner modes. Runner selection is not release or deployment authority.
No personal machine names, addresses, credentials or provider-specific runner provisioning belong here.

## Reversible selection

`CI_RUNNER_MODE=self-hosted` enables the fixed Linux pools below for `push`, `schedule` and
`workflow_dispatch` on `refs/heads/main`. An unset variable, `github-hosted`, or an unrecognized
value retains each job's existing Ubuntu fallback. Non-main dispatches, tags and unrecognized
event shapes (including merge queues) stay hosted. A queued self-hosted job does not automatically
fall back if its pool is offline: revert the mode and start a new authorized run if needed.

| Role label | Actual worker | Work |
| --- | --- | --- |
| `instafy-ci-linux-arm64` | Ubuntu 24.04 Linux ARM64 | Native package, database and browser checks; ARM64 runtime images |
| `instafy-ci-linux-x64` | Ubuntu 24.04 Linux X64 | AMD64 service and runtime images |
| `instafy-ci-control` | Ubuntu 24.04 Linux ARM64 | Short boundary checks, authorizers, approvals and manifest assembly |
| `instafy-ci-coordinator` | Ubuntu 24.04 Linux ARM64 | Image coordinator waiting for CI and child publishers |

Every selector also requires `self-hosted`, `Linux` and the actual `ARM64` or `X64` label.
Do not apply Linux labels to a native macOS runner, or advertise X64 based on an unqualified
emulation layer. AMD64 image jobs additionally require `CI_LINUX_X64_SELF_HOSTED=true`; until an
actual X64 pool passes native build-and-scan qualification they retain their AMD64 hosted runners.
The ARM64/AMD64 matrix, Trivy scans, exact image digests and complete multiarchitecture manifests
are not reduced to fit available capacity. `npm-release` pack and publish remain hosted for
[npm's authentication and provenance constraints](Package-Releases.md).

Waiting coordinators must not consume the only short-control or build listener: reserve separate
capacity for their children. Do not put the coordinator role label on the only control worker.
Each worker needs its lane's existing tools: Git, Bash, Node, curl, jq and the GitHub CLI; Docker
and Buildx for image/manifest/database work; Rust/Go, build dependencies and browser/display
packages for the corresponding checks. Runner image provisioning must provide a fresh Linux guest
with enough RAM, disk and CPU for the unchanged job timeout. Labels express placement, not proof
that tools, resources or isolation are ready. Qualify the actual lane before enabling its pool.

## Temporary same-repository PR exception

PRs remain hosted unless all of these are true: the mode is `self-hosted`, the repository payload
is private, `CI_TRUSTED_PR_SELF_HOSTED=true`, and the PR head repository equals the base repository.
The exception applies to `pull_request` and the base-owned `pull_request_target` boundary check;
it never grants PR code repository, signing, deployment or production secrets. The boundary job
still executes only trusted base controls and treats the candidate checkout as unexecuted data.
Fork PRs remain hosted even when the flag is enabled. Making the repository public disables the
exception. Remove the flag when the temporary trust decision ends; it is not permanent contributor
trust, and administrators must reassess it before accepting unreviewed same-repository branches.

Use one-job disposable guests with no local developer credentials, host-mounted home directories,
production network access, signing material, or reused privileged process/Docker state. Destroy
the whole guest after the job; an ephemeral runner registration alone does not clean a persistent
host. PR guests must be isolated from protected-main/publishing guests even when they use the same
role label. Restrict runner-group repository access and accepted workflows independently: mutable
PR workflow YAML is not a security boundary against a malicious contributor requesting a label.
Do not activate the temporary exception where those infrastructure restrictions are unavailable.

Checkout credentials are non-persistent. Native caches include OS and architecture; this prevents
an AMD64 Docker tarball or Rust target cache being reused as ARM64 evidence. Hosted-only SDK disk
cleanup never runs on self-hosted workers. Browser launcher setup remains confined to the fresh
disposable guest, never a workstation.

## Validation

Run `node --test scripts/check-ci-runner-routing.test.mjs` with the workflow regression suites.
The routing test evaluates the actual YAML expressions across default, protected-main, trusted PR,
fork, public visibility, unknown event and X64 qualification cases. It proves selection and keeps
the existing lanes and npm exceptions explicit; it does not prove real host capacity or execution.
