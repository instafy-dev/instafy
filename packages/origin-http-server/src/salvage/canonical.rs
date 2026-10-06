//! The salvage's network steps against a space's canonical repository, all
//! through the entry's hardened git handle: fetch `main` (objects checked),
//! read one salvage ref's tip, and create a salvage ref.

use std::time::{Duration, Instant};

use anyhow::{bail, Result};

use crate::publish_policy::RejectReason;
use crate::push::{push, PushClass};
use crate::recovery_view::{remote_tip, RecoveryRef};
use crate::workspace_git::{RunOpts, WorkspaceGit};

/// How long one fetch, ls-remote or push may take in all.
const NETWORK_DEADLINE: Duration = Duration::from_secs(600);
/// Where canonical `main` is fetched to in the entry's repository.
pub(crate) const FETCHED_MAIN: &str = "refs/remotes/origin/main";

/// What canonical holds for the space.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Canonical {
    Main(String),
    /// The repository exists but has no `main`.
    NoMain,
    /// There is no repository.
    Missing,
}

/// Fetch canonical `main` into the entry's `refs/remotes/origin/main`, from
/// the computed URL (never the repository's own remote config), checking
/// every object received. Git's automatic maintenance stays off: after a
/// fetch it would expire the parked reflog (and prune what only the reflog
/// held), which is the evidence the stale rule reads, so a dry run would
/// change what it reports on.
pub(crate) fn fetch_main(git: &WorkspaceGit<'_>, url: &str) -> Result<Canonical> {
    let refspec = format!("+refs/heads/main:{FETCHED_MAIN}");
    let git = git.with_network_deadline(Instant::now() + NETWORK_DEADLINE);
    let output = git.run_opts(
        &[
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--end-of-options",
            url,
            &refspec,
        ],
        &RunOpts {
            env: vec![
                ("GIT_CONFIG_COUNT", "4".into()),
                ("GIT_CONFIG_KEY_0", "fetch.fsckObjects".into()),
                ("GIT_CONFIG_VALUE_0", "true".into()),
                ("GIT_CONFIG_KEY_1", "transfer.fsckObjects".into()),
                ("GIT_CONFIG_VALUE_1", "true".into()),
                ("GIT_CONFIG_KEY_2", "maintenance.auto".into()),
                ("GIT_CONFIG_VALUE_2", "false".into()),
                ("GIT_CONFIG_KEY_3", "gc.auto".into()),
                ("GIT_CONFIG_VALUE_3", "0".into()),
            ],
            ..RunOpts::default()
        },
    )?;
    if output.status.success() {
        return match git.commit_id(FETCHED_MAIN)? {
            Some(main) => Ok(Canonical::Main(main)),
            None => bail!("fetched canonical main but {FETCHED_MAIN} names no commit"),
        };
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("couldn't find remote ref") {
        return Ok(Canonical::NoMain);
    }
    if stderr.contains("does not appear to be a git repository")
        || stderr.contains("repository not found")
        || stderr.contains("returned error: 404")
    {
        return Ok(Canonical::Missing);
    }
    bail!(
        "fetching canonical main failed: {}",
        crate::workspace_git::failure(&["fetch"], &output)
    )
}

/// The tip of one salvage ref on canonical, if it exists.
pub(crate) fn salvage_tip(
    git: &WorkspaceGit<'_>,
    url: &str,
    reference: &str,
) -> Result<Option<String>> {
    let parsed = RecoveryRef::parse(reference)
        .map_err(|_| anyhow::anyhow!("{reference} is not a salvage ref name"))?;
    let git = git.with_network_deadline(Instant::now() + NETWORK_DEADLINE);
    remote_tip(&git, url, &parsed)
        .map_err(|error| anyhow::anyhow!("could not read {reference} on canonical: {error}"))
}

/// What one salvage push did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Pushed {
    /// The ref now names the commit.
    Created,
    /// The shard's policy refused one path; the caller may leave it as
    /// `main` has it and try again.
    PathRefused { path: String, reason: RejectReason },
    /// Final: a salvage refusal, a credential refusal, a ref that appeared
    /// meanwhile, or an outcome that is not known. Never retried.
    Failed(String),
}

/// Create `reference` = `commit` on canonical, only if it does not exist.
pub(crate) fn create_salvage_ref(
    git: &WorkspaceGit<'_>,
    url: &str,
    commit: &str,
    reference: &str,
) -> Result<Pushed> {
    let git = git.with_network_deadline(Instant::now() + NETWORK_DEADLINE);
    let refspec = format!("{commit}:{reference}");
    let result = push(&git, url, &[refspec], &[reference.to_string()])?;
    Ok(match result.class {
        PushClass::Pushed => Pushed::Created,
        PushClass::PathRejected { path, reason } => Pushed::PathRefused { path, reason },
        PushClass::LostRace(text) => {
            Pushed::Failed(format!("the ref already exists on canonical: {text}"))
        }
        PushClass::Rejected(text) => Pushed::Failed(format!("canonical refused the push: {text}")),
        PushClass::Ambiguous(text) => {
            Pushed::Failed(format!("the push may or may not have landed: {text}"))
        }
    })
}
