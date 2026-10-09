//! Pushes to the canonical remote and what their failures mean.
//!
//! Every push is a plain push: a ref moves only when the new commit has the
//! remote's tip as an ancestor, or, for a ref that must not exist yet,
//! under `--force-with-lease=<ref>:` (create only). The one ref that moves
//! otherwise is a working folder's rolling save
//! ([`push_replace_with_lease`]), and only while it still names the exact
//! commit its saver last confirmed. Nothing here can rewrite any other remote
//! ref.

use std::process::Output;

use anyhow::{bail, Result};

use crate::publish_policy::RejectReason;
use crate::workspace_git::WorkspaceGit;

/// What a failed (or successful) push means for the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PushClass {
    Pushed,
    /// Another writer moved the ref first: fetch again and retry.
    LostRace(String),
    /// The repository policy refused one path; drop it and retry.
    PathRejected {
        path: String,
        reason: RejectReason,
        /// Every other path the same refusal named: a shard names each path
        /// it refuses in one push (an older one only the first).
        others: Vec<String>,
    },
    /// Any other refusal. Retrying the same push cannot succeed.
    Rejected(String),
    /// The outcome is unknown (the connection failed): check the remote.
    Ambiguous(String),
}

/// One per-ref line of `git push --porcelain`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PushedRef {
    pub flag: char,
    pub to: String,
    pub summary: String,
}

impl PushedRef {
    /// The ref now holds what was pushed (new, updated or already equal).
    pub(crate) fn ok(&self) -> bool {
        matches!(self.flag, ' ' | '*' | '=')
    }
}

/// A finished push: the classification and the per-ref results.
pub(crate) struct PushResult {
    pub class: PushClass,
    pub refs: Vec<PushedRef>,
}

#[cfg(test)]
pub(crate) enum PushHookAction {
    /// Run the push normally.
    Proceed,
    /// Run the push, then report the connection as lost.
    LoseResponse,
    /// Report the connection as lost without running the push, so the
    /// remote never sees it (a working slot's replace or a leased delete
    /// only).
    DropRequest,
}

#[cfg(test)]
type PushHook = Box<dyn FnMut(&[String]) -> PushHookAction>;

#[cfg(test)]
thread_local! {
    static PUSH_HOOK: std::cell::RefCell<Option<PushHook>> = const { std::cell::RefCell::new(None) };
}

/// Run `hook` before every push made on this thread, ref deletes included
/// (tests only).
#[cfg(test)]
pub(crate) fn set_push_hook(hook: impl FnMut(&[String]) -> PushHookAction + 'static) {
    PUSH_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
pub(crate) fn clear_push_hook() {
    PUSH_HOOK.with(|slot| *slot.borrow_mut() = None);
}

#[cfg(test)]
fn run_push_hook(refspecs: &[String]) -> PushHookAction {
    let hook = PUSH_HOOK.with(|slot| slot.borrow_mut().take());
    match hook {
        Some(mut hook) => {
            let action = hook(refspecs);
            PUSH_HOOK.with(|slot| {
                let mut slot = slot.borrow_mut();
                if slot.is_none() {
                    *slot = Some(hook);
                }
            });
            action
        }
        None => PushHookAction::Proceed,
    }
}

/// Push `refspecs` (`<id>:<ref>`, never `+`-prefixed) to `remote`.
/// `create_only` names refs that must not exist on the remote yet. A forced
/// refspec is refused before anything runs.
pub(crate) fn push(
    git: &WorkspaceGit<'_>,
    remote: &str,
    refspecs: &[String],
    create_only: &[String],
) -> Result<PushResult> {
    if refspecs.iter().any(|spec| spec.starts_with('+')) {
        bail!("a forced refspec is never pushed");
    }
    let leases: Vec<String> = create_only
        .iter()
        .map(|reference| format!("--force-with-lease={reference}:"))
        .collect();
    let mut args: Vec<&str> = vec!["push", "--porcelain", "--no-verify"];
    args.extend(leases.iter().map(String::as_str));
    args.push(remote);
    args.extend(refspecs.iter().map(String::as_str));

    #[cfg(test)]
    let lose_response = matches!(run_push_hook(refspecs), PushHookAction::LoseResponse);

    let output = git.run(&args)?;

    #[cfg(test)]
    if lose_response {
        let lost = Output {
            status: failed_status(),
            stdout: Vec::new(),
            stderr: b"fatal: the remote end hung up unexpectedly\n".to_vec(),
        };
        return Ok(PushResult {
            class: classify_output(&lost),
            refs: Vec::new(),
        });
    }

    Ok(PushResult {
        class: classify_output(&output),
        refs: parse_porcelain(&output.stdout),
    })
}

/// Delete `destination` on `remote` only while it still names `rev`: a
/// ref that moved or is gone is left alone and the push fails as a lost
/// race. Used to dismiss unsaved work and to remove a restored recovery
/// ref.
pub(crate) fn delete_with_lease(
    git: &WorkspaceGit<'_>,
    remote: &str,
    destination: &str,
    rev: &str,
) -> Result<PushResult> {
    let lease = format!("--force-with-lease={destination}:{rev}");
    let delete = format!(":{destination}");

    #[cfg(test)]
    let action = run_push_hook(std::slice::from_ref(&delete));
    #[cfg(test)]
    if matches!(action, PushHookAction::DropRequest) {
        return Ok(lost_connection());
    }
    #[cfg(test)]
    let lose_response = matches!(action, PushHookAction::LoseResponse);

    let output = git.run(&[
        "push",
        "--porcelain",
        "--no-verify",
        &lease,
        remote,
        &delete,
    ])?;

    #[cfg(test)]
    if lose_response {
        let lost = Output {
            status: failed_status(),
            stdout: Vec::new(),
            stderr: b"fatal: the remote end hung up unexpectedly\n".to_vec(),
        };
        return Ok(PushResult {
            class: classify_output(&lost),
            refs: Vec::new(),
        });
    }

    Ok(PushResult {
        class: classify_output(&output),
        refs: parse_porcelain(&output.stdout),
    })
}

/// Set the working slot `destination` to `commit` while it still names
/// `expected` (`None`: while it does not exist yet). Each save of a working
/// folder sits on `main`, not on the save before it, so the update is not a
/// fast-forward; the lease on the exact tip the saver last confirmed is what
/// keeps it from replacing anyone else's save. A slot that moved, or exists
/// when it should not, is refused as a lost race and left alone.
pub(crate) fn push_replace_with_lease(
    git: &WorkspaceGit<'_>,
    remote: &str,
    commit: &str,
    destination: &str,
    expected: Option<&str>,
) -> Result<PushResult> {
    if !git_service::policy::is_working_slot_ref(destination) {
        bail!("only a working slot is replaced under a lease");
    }
    let rev = expected.unwrap_or_default();
    let lease = format!("--force-with-lease={destination}:{rev}");
    let spec = format!("{commit}:{destination}");

    #[cfg(test)]
    let action = run_push_hook(std::slice::from_ref(&spec));
    #[cfg(test)]
    if matches!(action, PushHookAction::DropRequest) {
        return Ok(lost_connection());
    }
    #[cfg(test)]
    let lose_response = matches!(action, PushHookAction::LoseResponse);

    let output = git.run(&["push", "--porcelain", "--no-verify", &lease, remote, &spec])?;

    #[cfg(test)]
    if lose_response {
        let lost = Output {
            status: failed_status(),
            stdout: Vec::new(),
            stderr: b"fatal: the remote end hung up unexpectedly\n".to_vec(),
        };
        return Ok(PushResult {
            class: classify_output(&lost),
            refs: Vec::new(),
        });
    }

    Ok(PushResult {
        class: classify_output(&output),
        refs: parse_porcelain(&output.stdout),
    })
}

/// What a push whose connection failed answers (tests only).
#[cfg(test)]
fn lost_connection() -> PushResult {
    let lost = Output {
        status: failed_status(),
        stdout: Vec::new(),
        stderr: b"fatal: the remote end hung up unexpectedly\n".to_vec(),
    };
    PushResult {
        class: classify_output(&lost),
        refs: Vec::new(),
    }
}

#[cfg(all(test, unix))]
fn failed_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt as _;
    std::process::ExitStatus::from_raw(128 << 8)
}

#[cfg(all(test, windows))]
fn failed_status() -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt as _;
    std::process::ExitStatus::from_raw(128)
}

fn classify_output(output: &Output) -> PushClass {
    if output.status.success() {
        return PushClass::Pushed;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    classify_push(&text)
}

/// Classify the combined stdout and stderr of a failed push.
pub(crate) fn classify_push(text: &str) -> PushClass {
    let lower = text.to_ascii_lowercase();
    // Checked first: the shard hook's fast-forward refusal also reads
    // "hook declined", and must be retried rather than parked.
    const LOST_RACE: &[&str] = &[
        "non-fast-forward",
        "fetch first",
        "stale info",
        "incorrect old value",
        "cannot lock ref",
        "failed to update ref",
    ];
    if LOST_RACE.iter().any(|marker| lower.contains(marker)) {
        return PushClass::LostRace(summary(text));
    }
    for (marker, reason) in PATH_REFUSALS {
        if let Some(path) = quoted_after(text, marker) {
            let mut others = Vec::new();
            for line in text.lines() {
                for (marker, _) in PATH_REFUSALS {
                    if let Some(other) = quoted_in(line, marker) {
                        if other != path && !others.contains(&other) {
                            others.push(other);
                        }
                    }
                }
            }
            return PushClass::PathRejected {
                path,
                reason,
                others,
            };
        }
    }
    const PERMANENT: &[&str] = &[
        "[remote rejected]",
        "[rejected]",
        "hook declined",
        "permission denied",
        "access denied",
        "authentication failed",
        "requested url returned error: 401",
        "requested url returned error: 403",
        "requested url returned error: 404",
        "requested url returned error: 413",
        "repository not found",
        "not allowed",
    ];
    if PERMANENT.iter().any(|marker| lower.contains(marker)) {
        return PushClass::Rejected(summary(text));
    }
    PushClass::Ambiguous(summary(text))
}

/// The shard hook's refusals of one path, and what each means.
const PATH_REFUSALS: [(&str, RejectReason); 3] = [
    ("blocked path '", RejectReason::Policy),
    ("file too large '", RejectReason::TooLarge),
    ("blocked non-blob object for '", RejectReason::Unsupported),
];

/// The text between `marker` and the next `' (` (or the line's last quote)
/// on the first line that holds one.
fn quoted_after(text: &str, marker: &str) -> Option<String> {
    text.lines().find_map(|line| quoted_in(line, marker))
}

fn quoted_in(line: &str, marker: &str) -> Option<String> {
    let start = line.find(marker)?;
    let rest = &line[start + marker.len()..];
    let end = rest.rfind("' (").or_else(|| rest.rfind('\''))?;
    let path = rest[..end].to_string();
    (!path.is_empty()).then_some(path)
}

fn summary(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "Done" && !line.starts_with("To "))
        .collect();
    let joined = lines.join("; ");
    if joined.len() > 600 {
        let mut cut = 600;
        while !joined.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}...", &joined[..cut])
    } else {
        joined
    }
}

/// Parse `<flag>\t<from>:<to>\t<summary>` lines.
pub(crate) fn parse_porcelain(stdout: &[u8]) -> Vec<PushedRef> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let flag = parts.next()?;
            let refs = parts.next()?;
            let summary = parts.next().unwrap_or_default().to_string();
            let mut flag_chars = flag.chars();
            let flag = flag_chars.next()?;
            if flag_chars.next().is_some() {
                return None;
            }
            let to = refs.rsplit_once(':').map(|(_, to)| to)?.to_string();
            Some(PushedRef { flag, to, summary })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_fast_forward_refusal_is_a_lost_race() {
        let text = "remote: instafy: non-fast-forward updates to main are not allowed\n\
                    remote: error: hook declined to update refs/heads/main\n\
                    !\trefs/heads/main:refs/heads/main\t[remote rejected] (hook declined)";
        assert!(matches!(classify_push(text), PushClass::LostRace(_)));
    }

    #[test]
    fn client_side_races_are_retried() {
        for text in [
            "!\tabc:refs/heads/main\t[rejected] (fetch first)",
            "!\tabc:refs/heads/main\t[rejected] (non-fast-forward)",
            "!\tHEAD~1:refs/heads/main\t[rejected] (stale info)",
            "remote: error: cannot lock ref 'refs/heads/main': is at x but expected y",
            "!\tabc:refs/heads/main\t[remote rejected] (failed to update ref)",
        ] {
            assert!(
                matches!(classify_push(text), PushClass::LostRace(_)),
                "{text}"
            );
        }
    }

    #[test]
    fn hook_path_rejections_name_the_path() {
        assert_eq!(
            classify_push(
                "remote: instafy: blocked path 'x/node_modules/y' (repo hygiene policy)        \n\
                 !\tabc:refs/heads/main\t[remote rejected] (hook declined)"
            ),
            PushClass::PathRejected {
                path: "x/node_modules/y".to_string(),
                reason: RejectReason::Policy,
                others: Vec::new(),
            }
        );
        assert_eq!(
            classify_push("remote: instafy: file too large 'data/it's big.csv' (30 bytes > 10)"),
            PushClass::PathRejected {
                path: "data/it's big.csv".to_string(),
                reason: RejectReason::TooLarge,
                others: Vec::new(),
            }
        );
        assert_eq!(
            classify_push(
                "remote: instafy: blocked non-blob object for 'vendor/lib' (type=commit)"
            ),
            PushClass::PathRejected {
                path: "vendor/lib".to_string(),
                reason: RejectReason::Unsupported,
                others: Vec::new(),
            }
        );
    }

    /// A refusal that names several paths keeps the first one an older
    /// shard named alone, and lists the rest.
    #[test]
    fn a_refusal_of_several_paths_names_them_all() {
        assert_eq!(
            classify_push(
                "remote: instafy: blocked path 'assets/a.zip' (repo hygiene policy)\n\
                 remote: instafy: blocked path 'dist/app.js' (repo hygiene policy)\n\
                 remote: instafy: file too large 'big.bin' (11 bytes > 8)\n\
                 remote: instafy: blocked path 'assets/a.zip' (repo hygiene policy)\n\
                 !\tabc:refs/heads/main\t[remote rejected] (hook declined)"
            ),
            PushClass::PathRejected {
                path: "assets/a.zip".to_string(),
                reason: RejectReason::Policy,
                others: vec!["dist/app.js".to_string(), "big.bin".to_string()],
            }
        );
    }

    #[test]
    fn other_refusals_are_permanent_and_disconnects_ambiguous() {
        assert!(matches!(
            classify_push("remote: instafy: 'refs/instafy/x' is not a recovery ref\n!\ta:refs/instafy/x\t[remote rejected] (hook declined)"),
            PushClass::Rejected(_)
        ));
        assert!(matches!(
            classify_push(
                "fatal: unable to access 'https://x/': The requested URL returned error: 403"
            ),
            PushClass::Rejected(_)
        ));
        assert!(matches!(
            classify_push("fatal: the remote end hung up unexpectedly"),
            PushClass::Ambiguous(_)
        ));
        assert!(matches!(
            classify_push("error: RPC failed; curl 28 Operation too slow"),
            PushClass::Ambiguous(_)
        ));
    }

    /// A delete goes through only while the ref still names what the
    /// caller saw: a ref moved behind its back, or already gone, is a lost
    /// race and stays as it is.
    #[test]
    fn a_ref_delete_holds_its_lease() {
        use crate::test_support::git_in;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        git_in(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git_in(&root, &["init", "-q", "--bare", "-b", "main", "local.git"]);
        let remote = root.join("remote.git");
        let empty = git_in(&remote, &["mktree"]);
        let commit = |message: &str| {
            git_in(
                &remote,
                &[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@instafy.dev",
                    "commit-tree",
                    &empty,
                    "-m",
                    message,
                ],
            )
        };
        let (seen, newer) = (commit("seen"), commit("newer"));
        let reference = "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60/\
                         20261004T120000Z-unsaved-0123456789ab";
        let local_dir = root.join("local.git");
        let local = WorkspaceGit::bare(&local_dir, None);
        let url = format!("file://{}", remote.display());
        let tip = || {
            crate::test_support::git_output(
                &remote,
                &["rev-parse", "--verify", "-q", reference],
                None,
            )
        };

        // Moved after the caller saw it.
        git_in(&remote, &["update-ref", reference, &newer]);
        let result = delete_with_lease(&local, &url, reference, &seen).unwrap();
        assert!(
            matches!(result.class, PushClass::LostRace(_)),
            "{:?}",
            result.class
        );
        assert_eq!(String::from_utf8_lossy(&tip().stdout).trim(), newer);

        // Already gone.
        git_in(&remote, &["update-ref", "-d", reference]);
        let result = delete_with_lease(&local, &url, reference, &seen).unwrap();
        assert!(
            matches!(result.class, PushClass::LostRace(_)),
            "{:?}",
            result.class
        );
        assert!(!tip().status.success());

        // Still what the caller saw: removed.
        git_in(&remote, &["update-ref", reference, &seen]);
        let result = delete_with_lease(&local, &url, reference, &seen).unwrap();
        assert_eq!(result.class, PushClass::Pushed);
        assert!(!tip().status.success());
    }

    #[test]
    fn a_delete_under_a_lease_removes_only_the_listed_tip() {
        use crate::test_support::git_in;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let remote = base.join("remote.git");
        git_in(
            &base,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        let work = base.join("work");
        git_in(&base, &["init", "-q", "-b", "main", work.to_str().unwrap()]);
        let commit = |message: &str| {
            git_in(
                &work,
                &[
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@example.com",
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    message,
                ],
            );
            git_in(&work, &["rev-parse", "HEAD"])
        };
        let first = commit("one");
        let second = commit("two");
        let listed = "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60/a";
        let moved = "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60/b";
        let remote_url = remote.to_str().unwrap();
        git_in(
            &work,
            &[
                "push",
                "-q",
                remote_url,
                &format!("{first}:{listed}"),
                &format!("{second}:{moved}"),
            ],
        );
        let mirror = base.join("mirror.git");
        WorkspaceGit::init_bare(&mirror).unwrap();
        let git = WorkspaceGit::bare(&mirror, None);

        // Listed at `first`, still there: deleted.
        let deleted = delete_with_lease(&git, remote_url, listed, &first).unwrap();
        assert_eq!(deleted.class, PushClass::Pushed);
        assert_eq!(deleted.refs[0].flag, '-');
        // Gone now, and one that moved since it was listed: both refused
        // as stale, and the moved one stays.
        for (reference, rev) in [(listed, &first), (moved, &first)] {
            let refused = delete_with_lease(&git, remote_url, reference, rev).unwrap();
            assert!(
                matches!(refused.class, PushClass::LostRace(_)),
                "{reference}: {:?}",
                refused.class
            );
        }
        let left = git_in(
            &remote,
            &["for-each-ref", "--format=%(refname) %(objectname)"],
        );
        assert!(left.contains(&format!("{moved} {second}")), "{left}");
        assert!(!left.contains(listed), "{left}");
    }

    #[test]
    fn a_forced_refspec_is_refused_before_anything_runs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        crate::test_support::git_in(&root, &["init", "-q", "--bare", "-b", "main", "local.git"]);
        let local_dir = root.join("local.git");
        let local = WorkspaceGit::bare(&local_dir, None);
        let error = push(
            &local,
            "file:///nonexistent",
            &["+abc:refs/heads/main".to_string()],
            &[],
        )
        .err()
        .expect("a forced refspec is refused");
        assert!(error.to_string().contains("forced refspec"), "{error}");
    }

    /// A working slot moves to a commit that is not a fast-forward only
    /// while it names the exact tip the saver confirmed; a create needs it
    /// absent. Other refs are never replaced this way.
    #[test]
    fn a_working_slot_is_replaced_only_under_its_lease() {
        use crate::test_support::git_in;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        git_in(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git_in(&root, &["init", "-q", "--bare", "-b", "main", "local.git"]);
        let remote = root.join("remote.git");
        let local_dir = root.join("local.git");
        let local = WorkspaceGit::bare(&local_dir, None);
        let commit = |message: &str| {
            let tree = git_in(&local_dir, &["mktree"]);
            git_in(
                &local_dir,
                &[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@instafy.dev",
                    "commit-tree",
                    &tree,
                    "-m",
                    message,
                ],
            )
        };
        let (first, second, third) = (commit("first"), commit("second"), commit("third"));
        let slot = format!(
            "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60/{}",
            git_service::policy::WORKING_SLOT_NAME
        );
        let url = format!("file://{}", remote.display());
        let tip = || {
            let output = crate::test_support::git_output(
                &remote,
                &["rev-parse", "--verify", "-q", &slot],
                None,
            );
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        };

        let created = push_replace_with_lease(&local, &url, &first, &slot, None).unwrap();
        assert_eq!(created.class, PushClass::Pushed);
        assert_eq!(tip().as_deref(), Some(first.as_str()));
        // Unrelated commits: never a fast-forward.
        let replaced = push_replace_with_lease(&local, &url, &second, &slot, Some(&first)).unwrap();
        assert_eq!(replaced.class, PushClass::Pushed);
        assert_eq!(tip().as_deref(), Some(second.as_str()));
        for expected in [Some(first.as_str()), None] {
            let refused = push_replace_with_lease(&local, &url, &third, &slot, expected).unwrap();
            assert!(
                matches!(refused.class, PushClass::LostRace(_)),
                "{expected:?}: {:?}",
                refused.class
            );
            assert_eq!(tip().as_deref(), Some(second.as_str()));
        }
        let content = "refs/instafy/recovery/0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60/x";
        assert!(push_replace_with_lease(&local, &url, &third, content, None).is_err());
    }

    #[test]
    fn porcelain_lines_are_parsed() {
        let refs = parse_porcelain(
            b"To ../remote.git\n*\tabc:refs/instafy/recovery/x/y\t[new reference]\n=\tdef:refs/instafy/recovery/x/z\t[up to date]\n!\tHEAD:refs/heads/main\t[rejected] (fetch first)\nDone\n",
        );
        assert_eq!(refs.len(), 3);
        assert!(refs[0].ok() && refs[1].ok() && !refs[2].ok());
        assert_eq!(refs[0].to, "refs/instafy/recovery/x/y");
        assert_eq!(refs[2].summary, "[rejected] (fetch first)");
    }
}
