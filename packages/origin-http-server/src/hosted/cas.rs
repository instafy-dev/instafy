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
use std::time::{Duration, Instant, SystemTime};

use tracing::{info, warn};
use uuid::Uuid;

use super::answers::{idempotency_conflict, internal, main_busy, push_rejected, reason_name};
use super::cache::{is_fetch_pending, Freshness, MirrorCache, MirrorLease};
use super::change::Change;
use super::routes::Admission;
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
/// A `git.write` credential is exchanged again before a push when less
/// than this is left of it (the controller issues them for 60 s at most).
pub(crate) const CREDENTIAL_MARGIN: Duration = Duration::from_secs(15);

/// The trailer naming an import's apply key (the controller's `imp:` key).
pub(crate) const APPLY_KEY_TRAILER: &str = "Instafy-Apply-Key";
/// The trailer holding the import request's fingerprint.
pub(crate) const APPLY_FINGERPRINT_TRAILER: &str = "Instafy-Apply-Fingerprint";
/// The trailers holding what an import carried: the files it kept and
/// their total size, as its first answer counted them. A replay or a status
/// check answers exactly these (a commit's own diff counts nothing for an
/// import that changed nothing, and leaves out files it did not change).
pub(crate) const APPLY_FILES_TRAILER: &str = "Instafy-Apply-Files";
pub(crate) const APPLY_BYTES_TRAILER: &str = "Instafy-Apply-Bytes";
/// How far back an import's key is looked for.
const APPLY_KEY_WINDOW: &str = "--since=31.days.ago";
/// How many key matches are inspected (a forged one cannot hide a real one
/// behind it for long).
const APPLY_KEY_MATCHES: &str = "64";

/// The longest commit message a caller can set.
const MAX_MESSAGE_BYTES: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// Identities and messages.
// ---------------------------------------------------------------------------

/// The author of a person's change: [`OriginClaims::user_author`], the
/// rule Desktop saves by (the per-space pseudonym and display name on a
/// person's own token), or the gateway's own identity for a job's token
/// (one that names a run), a token without author claims (an older
/// controller, or one without the author keyring) and an address that is
/// not a pseudonym. The token's subject never is.
pub(crate) fn save_author(claims: &OriginClaims, gateway: &GitIdentity) -> GitIdentity {
    claims
        .user_author()
        .unwrap_or_else(|| GitIdentity::new(gateway.name.clone(), gateway.email.clone()))
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

/// `message` as committed: the import's trailers (its key, fingerprint and
/// `counts`) appended in a paragraph of their own.
fn full_message(message: &str, key: Option<&ApplyKey>, counts: Option<(usize, u64)>) -> String {
    let mut text = message.trim_end().to_string();
    text.push('\n');
    if let Some(key) = key {
        text.push_str(&format!("\n{APPLY_KEY_TRAILER}: {}\n", key.key));
        if let Some(fingerprint) = &key.fingerprint {
            text.push_str(&format!("{APPLY_FINGERPRINT_TRAILER}: {fingerprint}\n"));
        }
        if let Some((files, bytes)) = counts {
            text.push_str(&format!("{APPLY_FILES_TRAILER}: {files}\n"));
            text.push_str(&format!("{APPLY_BYTES_TRAILER}: {bytes}\n"));
        }
    }
    text
}

// ---------------------------------------------------------------------------
// Canonical `main`, as the mirror cache sees it.
// ---------------------------------------------------------------------------

/// Canonical `main` for one change: fetched fresh, pushed to with a
/// current credential, and told when a push landed.
pub(crate) trait Canonical {
    /// `main` from a fetch that starts after this call (`None`: no `main`).
    fn fetch_main(&mut self) -> Result<Option<String>, OriginError>;
    /// The `git.write` credential to push with now (`None`: the server
    /// needs none). Exchanged again whenever what is held runs out within
    /// [`CREDENTIAL_MARGIN`]: a change can outlive one credential.
    fn write_token(&mut self) -> Result<Option<String>, OriginError>;
    /// Canonical refused the credential last handed out: the next
    /// [`Self::write_token`] exchanges a new one.
    fn write_token_refused(&mut self);
    /// `commit`, on top of `old`, is canonical `main` now; its objects are
    /// in the mirror when `promoted`.
    fn pushed(&mut self, commit: &str, old: Option<&str>, promoted: bool);
    /// A change's objects were moved into the mirror after the fetch that
    /// found its push had landed: the mirror's size changed again.
    fn grew(&mut self);
}

/// A `git.write` credential and when it runs out.
struct HeldCredential {
    token: String,
    expires: Instant,
}

/// [`Canonical`] through the mirror cache, for blocking work that runs on
/// a thread of the request's runtime.
pub(crate) struct CachedCanonical {
    cache: Arc<MirrorCache>,
    lease: MirrorLease,
    /// The caller's own bearer (`fs.write` for writes): what fetches mint
    /// read access with and pushes exchange for `git.write`.
    token: Option<String>,
    runtime: tokio::runtime::Handle,
    /// When the caller's bearer expires: no credential is exchanged for a
    /// later attempt once it is about to.
    caller_expires: Option<SystemTime>,
    held: Option<HeldCredential>,
    /// Whether any `git.write` credential was exchanged for this change.
    exchanged: bool,
    /// Until then, a fetch that is still running is waited for rather than
    /// answered as `fetch_pending` (the change's own budget).
    patience: Option<Instant>,
    /// The request's write slot: let go while a fetch runs.
    admission: Option<Admission>,
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
            caller_expires: None,
            held: None,
            exchanged: false,
            patience: None,
            admission: None,
        }
    }

    /// Wait out a slow fetch (a space's first clone) until `deadline`, or
    /// until shortly before the caller's bearer expires, whichever comes
    /// first: past that no credential could be exchanged for the push, so
    /// the caller is better told `fetch_pending` and asks again.
    pub(crate) fn wait_until(mut self, deadline: Instant) -> Self {
        self.patience = Some(deadline);
        self
    }

    /// Let `admission` go while each fetch runs, and take it again after.
    pub(crate) fn admission(mut self, admission: Option<Admission>) -> Self {
        self.admission = admission;
        self
    }

    /// Until when a fetch that is still running is waited for.
    fn patience_until(&self) -> Option<Instant> {
        let patience = self.patience?;
        let Some(expires) = self.caller_expires else {
            return Some(patience);
        };
        let left = expires
            .duration_since(SystemTime::now())
            .unwrap_or_default()
            .saturating_sub(CREDENTIAL_MARGIN);
        Some(patience.min(Instant::now() + left))
    }

    /// The caller's bearer expires at `expires` (its `exp` claim).
    pub(crate) fn caller_expires(mut self, expires: Option<SystemTime>) -> Self {
        self.caller_expires = expires;
        self
    }
}

impl Canonical for CachedCanonical {
    fn fetch_main(&mut self) -> Result<Option<String>, OriginError> {
        let arrived = Instant::now();
        let patience = self.patience_until();
        // Waiting on canonical is not work on this server: other writes may
        // take the slot meanwhile.
        if let Some(admission) = &self.admission {
            admission.pause();
        }
        let main = loop {
            let fetched = self.runtime.block_on(self.cache.resolve_main_since(
                &self.lease,
                Freshness::Fresh,
                self.token.as_deref(),
                arrived,
            ));
            match fetched {
                // The fetch goes on (a space's first clone): wait again
                // while the change has time left.
                Err(error)
                    if is_fetch_pending(&error)
                        && patience.is_some_and(|until| Instant::now() < until) => {}
                other => break other?,
            }
        };
        if let Some(admission) = &self.admission {
            self.runtime.block_on(admission.resume())?;
        }
        Ok(main)
    }

    fn write_token(&mut self) -> Result<Option<String>, OriginError> {
        if let Some(held) = &self.held {
            if held.expires > Instant::now() + CREDENTIAL_MARGIN {
                return Ok(Some(held.token.clone()));
            }
        }
        // A later attempt with the caller's own bearer about to expire
        // cannot get a credential that outlives it: stop here, with the
        // same answer as running out of attempts, rather than push with a
        // credential canonical will refuse.
        let caller_ending = self
            .caller_expires
            .is_some_and(|expires| expires <= SystemTime::now() + CREDENTIAL_MARGIN);
        if self.exchanged && caller_ending {
            info!("the caller's write access ends before another attempt could finish");
            return Err(main_busy());
        }
        let project = self.lease.project();
        let minted = match self
            .runtime
            .block_on(self.cache.write_token(project, self.token.as_deref()))
        {
            Ok(minted) => minted,
            // The first attempt outlived the caller's bearer (a slow build):
            // the controller refuses to exchange it. Nothing was pushed, so
            // this is the same answer as a later attempt that stops here,
            // not a server failure.
            Err(error) if caller_ending => {
                info!(%error, "the caller's write access ended before the first push");
                return Err(main_busy());
            }
            Err(error) => return Err(error),
        };
        self.exchanged = true;
        self.held = minted.map(|(token, lifetime)| HeldCredential {
            token,
            expires: Instant::now() + lifetime,
        });
        Ok(self.held.as_ref().map(|held| held.token.clone()))
    }

    fn write_token_refused(&mut self) {
        self.held = None;
    }

    fn pushed(&mut self, commit: &str, old: Option<&str>, promoted: bool) {
        self.cache
            .record_push(&self.lease.mirror(), commit, old, promoted);
    }

    fn grew(&mut self) {
        self.cache.size_changed(self.lease.project());
    }
}

/// Whether a failed push's output says canonical refused the credential
/// (an expired or revoked `git.write`): git asks for a password it is not
/// allowed to prompt for, or reports the HTTP refusal.
fn credential_refused(detail: &str) -> bool {
    const MARKERS: &[&str] = &[
        "unable to get password",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "authentication failed",
        "requested url returned error: 401",
    ];
    let lower = detail.to_ascii_lowercase();
    MARKERS.iter().any(|marker| lower.contains(marker))
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
    /// The gateway's identity: every commit's committer.
    pub committer: &'a GitIdentity,
    /// No new attempt starts after this.
    pub deadline: Instant,
    /// The request's write slot, let go before the first push.
    pub admission: Option<&'a Admission>,
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
    let committer = GitIdentity::new(
        target.committer.name.clone(),
        target.committer.email.clone(),
    );

    // Credentials refused in a row: one is exchanged again, two end it.
    let mut refused_credentials = 0;
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
                let receipt = receipt_counts(&plain, &applied)?;
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
        // The counts as this attempt leaves them (the shard may have
        // refused a path an earlier attempt kept).
        let text = full_message(message, key, change.receipt_counts());
        let commit = staged
            .commit_tree(&tree, &parents, author, &committer, text.as_bytes())
            .map_err(internal)?;
        // The push waits on canonical, not on this server: other writes
        // may build theirs meanwhile.
        if let Some(admission) = target.admission {
            admission.release();
        }
        let push_deadline = target.deadline.max(Instant::now() + PUSH_GRACE);
        let write_token = canonical.write_token()?;
        let pusher = WorkspaceGit::bare(target.mirror, write_token.as_deref())
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
        // Canonical refused the credential before taking anything: once,
        // a new one is exchanged and the change tried again; twice in a row
        // is a refusal, not an outcome to settle by fetching.
        if let PushClass::Rejected(detail) | PushClass::Ambiguous(detail) = &class {
            if credential_refused(detail) {
                refused_credentials += 1;
                warn!(attempt, detail = %detail, "canonical refused the write credential");
                if refused_credentials > 1 {
                    return Err(push_rejected());
                }
                canonical.write_token_refused();
                continue;
            }
        }
        refused_credentials = 0;
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
                        // The fetch already moved the mirror's main past it;
                        // what is moved in now came after that fetch.
                        if promote(&quarantine, &plain) {
                            canonical.grew();
                        }
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
    /// The files and bytes its trailers record (`None` for a commit made
    /// before they were written).
    pub counts: Option<(usize, u64)>,
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
        "--pretty=format:%H%x1f{token}%x1f%P%x1f{token}%x1f%cE%x1f{token}%x1f%(trailers:key={APPLY_KEY_TRAILER},valueonly)%x1f{token}%x1f%(trailers:key={APPLY_FINGERPRINT_TRAILER},valueonly)%x1f{token}%x1f%(trailers:key={APPLY_FILES_TRAILER},valueonly)%x1f{token}%x1f%(trailers:key={APPLY_BYTES_TRAILER},valueonly)%x1e{token}%x1e"
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
        let [commit, parents, committer, keys, fingerprints, files, bytes] = fields.as_slice()
        else {
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
            fingerprint: first_value(fingerprints).map(str::to_string),
            counts: first_value(files)
                .and_then(|files| files.parse().ok())
                .zip(first_value(bytes).and_then(|bytes| bytes.parse().ok())),
        }));
    }
    Ok(None)
}

/// The first non-empty line of a trailer's values.
fn first_value(values: &str) -> Option<&str> {
    values
        .lines()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

/// An import's receipt counts: what its trailers record, or for a commit
/// made before they were written, the files it added or changed.
pub(crate) fn receipt_counts(
    git: &WorkspaceGit<'_>,
    applied: &AppliedImport,
) -> Result<(usize, u64), OriginError> {
    match applied.counts {
        Some(counts) => Ok(counts),
        None => applied_size(git, &applied.commit, applied.parent.as_deref()),
    }
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
