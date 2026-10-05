//! Saves on the hosted gateway. Every change becomes one commit on
//! canonical `main`, built from git objects in a quarantine and pushed as a
//! plain fast-forward (or create-only, for a space without `main`).
//!
//! An attempt fetches `main` (`E`), builds the new tree `T` from `E` and
//! the change (see [`super::change`] for what is refused), answers
//! `committed: false` when `T` is `E`'s tree (except for an import, whose
//! commit is its receipt), and otherwise checks what the client read before
//! it commits and pushes.
//!
//! The push is classified: a lost race fetches and tries again (at most
//! [`MAX_ATTEMPTS`] times within the budget, then 409 `main_busy`), an
//! unknown outcome is settled by fetching, and any refusal leaves nothing
//! in the mirror, because new objects reach it only after the push landed.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{info, warn};
use uuid::Uuid;

use super::answers::{idempotency_conflict, internal, main_busy, push_rejected, reason_name};
use super::cache::{Freshness, MirrorCache, MirrorLease};
use super::change::Change;
use crate::auth::OriginClaims;
use crate::error::OriginError;
use crate::git::is_full_object_id;
use crate::publish::parse_raw_changes;
use crate::push::{self, PushClass};
use crate::recovery_view::MAIN_REF;
use crate::workspace_git::{GitIdentity, Quarantine, WorkspaceGit};

/// How long a person's save keeps trying before it answers `main_busy`.
pub(crate) const SAVE_BUDGET: Duration = Duration::from_secs(10);
/// An import's budget, below the controller's 900 s import timeout.
pub(crate) const IMPORT_BUDGET: Duration = Duration::from_secs(840);
/// At most this many attempts (fetch, build, push) per change.
pub(crate) const MAX_ATTEMPTS: usize = 5;
/// A push is given at least this long, whatever is left of the budget.
const PUSH_GRACE: Duration = Duration::from_secs(120);

/// The trailer naming an import's apply key (the controller's `imp:` key).
pub(crate) const APPLY_KEY_TRAILER: &str = "Instafy-Apply-Key";
/// The trailer holding the import request's fingerprint.
pub(crate) const APPLY_FINGERPRINT_TRAILER: &str = "Instafy-Apply-Fingerprint";
/// How far back an import's key is looked for.
const APPLY_KEY_WINDOW: &str = "--since=31.days.ago";
/// How many key matches are inspected (a forged one cannot hide a real one
/// behind it for long).
const APPLY_KEY_MATCHES: &str = "64";

/// The name given to a person whose token carries an address but no name.
pub(crate) const DEFAULT_AUTHOR_NAME: &str = "Instafy user";

/// The longest commit message a caller can set.
const MAX_MESSAGE_BYTES: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// Identities and messages.
// ---------------------------------------------------------------------------

/// The author of a person's change: the display name and per-space
/// pseudonymous address the controller put on their token, or the
/// gateway's own identity when the token carries none (an older controller,
/// or one without the author keyring). The token's subject never is.
pub(crate) fn save_author(claims: &OriginClaims, gateway: &GitIdentity) -> GitIdentity {
    let email = claims
        .author_email
        .as_deref()
        .map(str::trim)
        .filter(|email| plausible_email(email));
    match email {
        Some(email) => GitIdentity::new(author_name(claims.author_name.as_deref()), email),
        None => GitIdentity::new(gateway.name.clone(), gateway.email.clone()),
    }
}

/// An address git takes as is: one `@`, no space, quote, angle bracket or
/// control character.
fn plausible_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && email.len() <= 254
        && email
            .chars()
            .all(|c| !c.is_control() && !c.is_whitespace() && !matches!(c, '<' | '>' | '"' | '\\'))
}

/// A display name git takes as is: no control characters or angle
/// brackets, no leading or trailing punctuation git would strip, at most 128
/// bytes; [`DEFAULT_AUTHOR_NAME`] when nothing is left.
fn author_name(name: Option<&str>) -> String {
    let cleaned: String = name
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() > 128 {
        let mut end = 128;
        while !collapsed.is_char_boundary(end) {
            end -= 1;
        }
        collapsed.truncate(end);
    }
    let trimmed = collapsed.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, '.' | ',' | ':' | ';' | '"' | '\'')
    });
    if trimmed.is_empty() {
        DEFAULT_AUTHOR_NAME.to_string()
    } else {
        trimmed.to_string()
    }
}

/// A caller's commit message with control characters other than newlines
/// and tabs dropped, and then every line that starts with `Instafy-` (any
/// letter case, after leading blanks) removed, since those trailers mean
/// something to the gateway. `None` when nothing is left.
///
/// The order matters: a line checked before its control characters are
/// dropped (`\u{1}Instafy-Restored-From: ...`) would pass the check and
/// then become a real trailer of a commit the gateway makes.
pub(crate) fn caller_message(text: Option<&str>) -> Option<String> {
    let text = text?;
    let kept: Vec<String> = text
        .lines()
        .map(|line| {
            line.chars()
                .filter(|c| *c == '\t' || !c.is_control())
                .collect::<String>()
        })
        .filter(|line| {
            !line
                .trim_start()
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("instafy-"))
        })
        .map(|line| line.trim_end().to_string())
        .collect();
    let joined = kept.join("\n");
    let mut message = joined.trim().to_string();
    if message.is_empty() {
        return None;
    }
    if message.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    Some(message)
}

/// The plain subject of a save: `Update <path>`, `Delete <path>` or
/// `Update <n> files`.
pub(crate) fn default_message(files: &[String], deletes: &[String]) -> String {
    match (files, deletes) {
        ([file], []) => format!("Update {file}"),
        ([], [delete]) => format!("Delete {delete}"),
        _ => format!("Update {} files", files.len() + deletes.len()),
    }
}

/// An import's key: the controller's `imp:` key and the request's
/// fingerprint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApplyKey {
    pub key: String,
    pub fingerprint: Option<String>,
}

/// `message` as committed: the import's trailers appended in a paragraph
/// of their own.
fn full_message(message: &str, key: Option<&ApplyKey>) -> String {
    let mut text = message.trim_end().to_string();
    text.push('\n');
    if let Some(key) = key {
        text.push_str(&format!("\n{APPLY_KEY_TRAILER}: {}\n", key.key));
        if let Some(fingerprint) = &key.fingerprint {
            text.push_str(&format!("{APPLY_FINGERPRINT_TRAILER}: {fingerprint}\n"));
        }
    }
    text
}

// ---------------------------------------------------------------------------
// Canonical `main`, as the mirror cache sees it.
// ---------------------------------------------------------------------------

/// Canonical `main` for one change: fetched fresh, and told when a push
/// landed.
pub(crate) trait Canonical {
    /// `main` from a fetch that starts after this call (`None`: no `main`).
    fn fetch_main(&mut self) -> Result<Option<String>, OriginError>;
    /// `commit`, on top of `old`, is canonical `main` now; its objects are
    /// in the mirror when `promoted`.
    fn pushed(&mut self, commit: &str, old: Option<&str>, promoted: bool);
}

/// [`Canonical`] through the mirror cache, for blocking work that runs on
/// a thread of the request's runtime.
pub(crate) struct CachedCanonical {
    cache: Arc<MirrorCache>,
    lease: MirrorLease,
    token: Option<String>,
    runtime: tokio::runtime::Handle,
}

impl CachedCanonical {
    pub(crate) fn new(
        cache: Arc<MirrorCache>,
        lease: MirrorLease,
        token: Option<String>,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        Self {
            cache,
            lease,
            token,
            runtime,
        }
    }
}

impl Canonical for CachedCanonical {
    fn fetch_main(&mut self) -> Result<Option<String>, OriginError> {
        self.runtime.block_on(self.cache.resolve_main(
            &self.lease,
            Freshness::Fresh,
            self.token.as_deref(),
        ))
    }

    fn pushed(&mut self, commit: &str, old: Option<&str>, promoted: bool) {
        self.cache
            .record_push(&self.lease.mirror(), commit, old, promoted);
    }
}

// ---------------------------------------------------------------------------
// The commit-and-push loop.
// ---------------------------------------------------------------------------

/// Where a change is committed.
pub(crate) struct CasTarget<'a> {
    /// The space's mirror (absolute).
    pub mirror: &'a Path,
    /// Where the change's object quarantine is made (absolute).
    pub quarantine_parent: &'a Path,
    /// The canonical repository.
    pub remote: &'a str,
    /// The `git.write` credential, when the server needs one.
    pub write_token: Option<&'a str>,
    /// The gateway's identity: every commit's committer.
    pub committer: &'a GitIdentity,
    /// No new attempt starts after this.
    pub deadline: Instant,
}

/// The result of a change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CasOutcome {
    /// `main` after the change: the new commit, or `main` as it was when
    /// nothing changed (`None`: a space without `main`).
    pub rev: Option<String>,
    /// The commit the change was made on.
    pub base_rev: Option<String>,
    pub committed: bool,
    /// An import that had already been committed; nothing new was made.
    pub replayed: bool,
    /// For a replayed import: the files its commit added or changed and
    /// their total size.
    pub receipt: Option<(usize, u64)>,
}

/// Commit `change` on canonical `main` as `author` (committed by the
/// gateway) with `message`, plus the import's trailers when `key` is set.
/// Blocking; see the module documentation for what is refused.
pub(crate) fn cas_commit(
    target: &CasTarget<'_>,
    change: &mut Change,
    author: &GitIdentity,
    message: &str,
    key: Option<&ApplyKey>,
    canonical: &mut dyn Canonical,
) -> Result<CasOutcome, OriginError> {
    let quarantine = Quarantine::create_in(target.quarantine_parent).map_err(internal)?;
    let plain = WorkspaceGit::bare(target.mirror, None);
    let staged = WorkspaceGit::bare(target.mirror, None).with_quarantine(&quarantine);
    let message = full_message(message, key);
    let committer = GitIdentity::new(
        target.committer.name.clone(),
        target.committer.email.clone(),
    );

    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 && Instant::now() >= target.deadline {
            break;
        }
        let main = canonical.fetch_main()?;
        if let Some(key) = key {
            if let Some(applied) =
                find_applied(&plain, main.as_deref(), &committer.email, &key.key)?
            {
                if applied.fingerprint != key.fingerprint {
                    return Err(idempotency_conflict());
                }
                let receipt = applied_size(&plain, &applied.commit, applied.parent.as_deref())?;
                return Ok(CasOutcome {
                    rev: Some(applied.commit),
                    base_rev: applied.parent,
                    committed: true,
                    replayed: true,
                    receipt: Some(receipt),
                });
            }
        }
        let tree = change.build(&staged, quarantine.path(), main.as_deref())?;
        let main_tree = match main.as_deref() {
            Some(main) => staged.tree_id(main),
            None => staged.empty_tree(),
        }
        .map_err(internal)?;
        // An import is committed even when it changes nothing: that commit,
        // carrying its key, is its receipt. Without it a retry after a lost
        // answer would find no receipt and write the import again, over
        // whatever was saved in between.
        if tree == main_tree && key.is_none() {
            change.settled(&staged, main.as_deref())?;
            return Ok(CasOutcome {
                rev: main.clone(),
                base_rev: main,
                committed: false,
                replayed: false,
                receipt: None,
            });
        }
        change.check(&staged, main.as_deref())?;

        let parents: Vec<&str> = main.iter().map(String::as_str).collect();
        let commit = staged
            .commit_tree(&tree, &parents, author, &committer, message.as_bytes())
            .map_err(internal)?;
        let push_deadline = target.deadline.max(Instant::now() + PUSH_GRACE);
        let pusher = WorkspaceGit::bare(target.mirror, target.write_token)
            .with_quarantine(&quarantine)
            .with_network_deadline(push_deadline);
        let create_only: Vec<String> = if main.is_none() {
            vec![MAIN_REF.to_string()]
        } else {
            Vec::new()
        };
        let class = match push::push(
            &pusher,
            target.remote,
            &[format!("{commit}:{MAIN_REF}")],
            &create_only,
        ) {
            Ok(result) => result.class,
            // The push may have been stopped after it landed.
            Err(error) => PushClass::Ambiguous(format!("{error:#}")),
        };
        match class {
            PushClass::Pushed => {
                let promoted = promote(&quarantine, &plain);
                canonical.pushed(&commit, main.as_deref(), promoted);
                return Ok(CasOutcome {
                    rev: Some(commit),
                    base_rev: main,
                    committed: true,
                    replayed: false,
                    receipt: None,
                });
            }
            PushClass::LostRace(detail) => {
                info!(attempt, detail = %detail, "another save landed first; trying again");
            }
            PushClass::PathRejected { path, reason } => {
                info!(
                    attempt,
                    reason = reason_name(reason),
                    "the shard refused a path"
                );
                change.refused(path, reason)?;
            }
            PushClass::Rejected(detail) => {
                warn!(detail = %detail, "the shard refused a save");
                return Err(push_rejected());
            }
            PushClass::Ambiguous(detail) => {
                warn!(attempt, detail = %detail, "a push ended without an answer; checking main");
                if let Some(after) = canonical.fetch_main()? {
                    if staged.is_ancestor(&commit, &after).map_err(internal)? {
                        // The fetch already moved the mirror's main past it.
                        promote(&quarantine, &plain);
                        return Ok(CasOutcome {
                            rev: Some(commit),
                            base_rev: main,
                            committed: true,
                            replayed: false,
                            receipt: None,
                        });
                    }
                }
            }
        }
        jitter(attempt);
    }
    Err(main_busy())
}

/// Move the quarantine's objects into the mirror; a failure only costs a
/// fetch later.
fn promote(quarantine: &Quarantine, mirror: &WorkspaceGit<'_>) -> bool {
    match quarantine.promote(mirror) {
        Ok(_) => true,
        Err(error) => {
            warn!(error = %format!("{error:#}"), "could not move a save's objects into the mirror");
            false
        }
    }
}

/// A short random pause before trying again, longer after each attempt.
fn jitter(attempt: usize) {
    let spread = 50 + u64::from(Uuid::new_v4().as_bytes()[0]) * 350 / 255;
    std::thread::sleep(Duration::from_millis(spread * attempt.min(3) as u64));
}

// ---------------------------------------------------------------------------
// Imports already committed.
// ---------------------------------------------------------------------------

/// A commit on `main` the gateway made for an import key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AppliedImport {
    pub commit: String,
    /// Its first parent (the `main` it was made on).
    pub parent: Option<String>,
    pub fingerprint: Option<String>,
}

/// The newest commit on `main`'s first-parent chain from the last 31 days
/// that the gateway committed (committer address exactly
/// `gateway_email`) with exactly `key` in [`APPLY_KEY_TRAILER`].
pub(crate) fn find_applied(
    git: &WorkspaceGit<'_>,
    main: Option<&str>,
    gateway_email: &str,
    key: &str,
) -> Result<Option<AppliedImport>, OriginError> {
    let Some(main) = main else {
        return Ok(None);
    };
    // Commit text is data: fields and records are framed with a token made
    // for this listing, which no commit written before it can contain.
    let token = Uuid::new_v4().simple().to_string();
    let field = format!("\u{1f}{token}\u{1f}");
    let record = format!("\u{1e}{token}\u{1e}");
    let pretty = format!(
        "--pretty=format:%H%x1f{token}%x1f%P%x1f{token}%x1f%cE%x1f{token}%x1f%(trailers:key={APPLY_KEY_TRAILER},valueonly)%x1f{token}%x1f%(trailers:key={APPLY_FINGERPRINT_TRAILER},valueonly)%x1e{token}%x1e"
    );
    let committer = format!("--committer=<{gateway_email}>");
    let grep = format!("--grep={APPLY_KEY_TRAILER}: {key}");
    let raw = git
        .stdout(&[
            "log",
            "--first-parent",
            "--max-count",
            APPLY_KEY_MATCHES,
            "--fixed-strings",
            &committer,
            &grep,
            APPLY_KEY_WINDOW,
            &pretty,
            "--end-of-options",
            main,
            "--",
        ])
        .map_err(internal)?;
    for raw_record in raw.split(record.as_str()) {
        let fields: Vec<&str> = raw_record.trim().split(field.as_str()).collect();
        let [commit, parents, committer, keys, fingerprints] = fields.as_slice() else {
            continue;
        };
        if !is_full_object_id(commit) || !committer.eq_ignore_ascii_case(gateway_email) {
            continue;
        }
        if !keys.lines().any(|value| value.trim() == key) {
            continue;
        }
        return Ok(Some(AppliedImport {
            commit: commit.to_string(),
            parent: parents
                .split_whitespace()
                .next()
                .filter(|parent| is_full_object_id(parent))
                .map(str::to_string),
            fingerprint: fingerprints
                .lines()
                .map(str::trim)
                .find(|value| !value.is_empty())
                .map(str::to_string),
        }));
    }
    Ok(None)
}

/// How many files `commit` added or changed against `parent` (everything,
/// for a root commit) and their total size: an import receipt.
pub(crate) fn applied_size(
    git: &WorkspaceGit<'_>,
    commit: &str,
    parent: Option<&str>,
) -> Result<(usize, u64), OriginError> {
    let raw = match parent {
        Some(parent) => git.bytes(&[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--raw",
            parent,
            commit,
        ]),
        None => git.bytes(&[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--raw",
            "--root",
            "--no-commit-id",
            commit,
        ]),
    }
    .map_err(internal)?;
    let blobs: Vec<String> = parse_raw_changes(&raw)
        .into_iter()
        .filter(|change| change.status != 'D' && change.new_mode != "160000")
        .map(|change| change.new_oid)
        .collect();
    let sizes = git.object_sizes(&blobs).map_err(internal)?;
    let bytes = sizes
        .iter()
        .flatten()
        .fold(0u64, |total, (_, size)| total.saturating_add(*size));
    Ok((blobs.len(), bytes))
}
