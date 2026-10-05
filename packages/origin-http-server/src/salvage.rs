//! `origin-http-server salvage`: keep the work the stateful gateway's working
//! copies held, so they can be removed.
//!
//! The stateless gateway parks every old working copy under
//! `<root>/.legacy/<space id>[-<time>]` before it serves (see
//! [`crate::hosted::park_legacy_checkouts`]). This subcommand runs inside the
//! gateway's container while the server runs, and touches only `.legacy/`
//! and `<root>/.salvage/` (mode 0700, one run at a time under
//! `.salvage/.lock`). For each entry:
//!
//! 1. The repository is `.instafy/.git`; a plain `.git` is first moved there
//!    inside the entry (`legacyLayout`). An entry without a usable repository
//!    (none, a link, a file, or one that points git at other objects or
//!    history) goes to the private archive whole (`noRepository`). A link
//!    named like a space is never followed (`linkEntry`).
//! 2. Every git command goes through [`WorkspaceGit`]: hooks off, the entry's
//!    config reduced to data-only settings, protocols pinned, replacement
//!    refs ignored (so the checks read what a push sends). Canonical `main`
//!    is fetched from the computed URL `<ORIGIN_GIT_REMOTE_BASE_URL>/<id>.git`,
//!    never the entry's own remote, with every received object checked, under
//!    a `git.read` credential the controller mints for the gateway's internal
//!    token. A missing repository is `canonicalMissing`.
//! 3. Changed, untracked and ignored paths are sorted ([`classify`]): stale
//!    copies of versions `main` already has are left out (`stalePaths`);
//!    ignored files, credentials and merge snapshots go to the owner-only
//!    archive; root `chat-upload-*` images are exported to the conversations
//!    that name them (and archived when they cannot be; when a rerun may
//!    still export one, `exportFailed`); build output, deny
//!    listed paths, files over 20 MiB and anything git cannot store are
//!    `skippedPaths`; the rest goes into W.
//! 4. W is HEAD plus those paths, committed under the gateway's identity at
//!    HEAD's commit date, so a rerun makes the same commit. Every commit
//!    canonical lacks, and W's whole change, is checked with the publish
//!    rules; with any hit, W becomes one commit on the last shared commit
//!    with those paths as `main` has them, and their local versions go to
//!    the private archive (`historyFiltered`). A path the rules allow keeps
//!    its version at W when only an earlier version was refused (over the
//!    size cap, or a gitlink); that version is reported skipped with its
//!    commit.
//! 5. When W is not on `main`, it is pushed create-only to
//!    `refs/instafy/salvage/gateway/<node>-<W[:8]>` with a `git.salvage`
//!    credential, then read back with `git.read` (`canonicalVerified`). An
//!    existing ref with the same tip is reported as verified; one with
//!    another tip stops the entry. A path the shard's policy refuses is left
//!    as `main` has it and the push is tried again with W rebuilt as one
//!    commit (at most 8 times, `historyFiltered`); any salvage refusal is
//!    final. When the entry holds what it held at a run that verified a
//!    salvage ref (same HEAD, same `sourceTree`) and canonical still has
//!    that ref at its commit, that ref is reported and nothing is pushed,
//!    whatever `main` (a restore of the ref) or the node name did since.
//! 6. `.salvage/<entry>.bundle` holds the entry's local history (all of it
//!    when canonical is missing), `.salvage/<entry>.private.tar` (0600) the
//!    private files, and `.salvage/report.jsonl` one line per entry and run.
//!    Each line goes to stdout first; when the journal cannot take it, the
//!    run stops before the next entry. Private files carry their sizes
//!    (`privateArchiveBytes` per entry, a total in the summary), and an
//!    entry whose outputs would leave the volume with less than the free
//!    space the gateway keeps (the mirror cache's 2 GiB floor) stops before
//!    writing them.
//!
//! Without `--apply` nothing is pushed, minted for writing, exported, or
//! written under `.salvage/`, and no file of an entry's work tree changes;
//! each entry is still fetched into its own repository and W's objects are
//! written there, so the report can name W. `--remove` (with `--apply`)
//! deletes an entry only when it was clean, or canonical now holds its
//! salvage ref at W, nothing was skipped outside build output, every chat
//! image was exported or given a final answer, and no history was filtered,
//! or the entry is named with `--ack`. Salvage refs and private archives are
//! never removed; a bundle only once canonical holds the raw history it has
//! (the ref verified at the unfiltered W). An entry whose run stopped before
//! its outputs were written and checked (the free-space floor, any error) is
//! never removed, even with `--ack`.

mod archive;
mod canonical;
mod classify;
mod journal;
mod options;
mod outputs;
mod repository;
mod services;
#[cfg(test)]
mod tests;
mod work;

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use uuid::Uuid;

use self::classify::{Kind, PrivatePath, Skipped};
use self::options::Settings;
use self::services::{ExportedTo, Services};
use crate::hosted::{ensure_private_dir, remove_entry, rename_no_replace};

pub(crate) use self::work::PRIVATE_PATH_TRAILER;

/// Run the subcommand with the arguments after `salvage`; returns the exit
/// status: 0 when every entry was handled, 1 when an entry failed, was not
/// removed, or has a chat image a rerun may still export, 2 for a usage or
/// configuration error.
pub async fn cli(args: Vec<String>) -> i32 {
    let flags = match options::parse_flags(&args) {
        Ok(flags) => flags,
        Err(error) => {
            eprintln!("salvage: {error:#}\n\n{}", options::USAGE);
            return 2;
        }
    };
    if flags.help {
        println!("{}", options::USAGE);
        return 0;
    }
    let env = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let settings = match Settings::from_flags(&flags, &env) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("salvage: {error:#}");
            return 2;
        }
    };
    let services =
        match services::ControllerServices::from_env(tokio::runtime::Handle::current(), &env) {
            Ok(services) => services,
            Err(error) => {
                eprintln!("salvage: {error:#}");
                return 2;
            }
        };
    let outcome = tokio::task::spawn_blocking(move || {
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        run(&settings, &services, &mut out)
    })
    .await;
    match outcome {
        Ok(Ok(summary)) => {
            eprintln!("{}", summary.describe());
            summary.exit_code()
        }
        Ok(Err(error)) => {
            eprintln!("salvage: {error:#}");
            1
        }
        Err(error) => {
            eprintln!("salvage: {error}");
            1
        }
    }
}

/// One exported chat image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportedAttachment {
    pub path: String,
    pub conversations: Vec<ExportedTo>,
}

/// What happened to one entry: one line of `report.jsonl`.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryReport {
    pub entry: String,
    pub project: Option<Uuid>,
    pub node: String,
    pub dry_run: bool,
    /// The entry's repository was read. False for a dry run of an entry
    /// whose `.git` is only moved with `--apply`, and for anything that is
    /// not a parked working copy.
    pub inspected: bool,
    pub head: Option<String>,
    /// HEAD's tree with the work tree's changes that W may take, before
    /// stale copies are left out: what the entry holds, whatever `main`
    /// does. A later run of an entry holding the same reuses the salvage
    /// ref recorded for it.
    pub source_tree: Option<String>,
    pub salvage_ref: Option<String>,
    pub salvage_rev: Option<String>,
    pub canonical_verified: bool,
    pub local_only_commits: usize,
    pub subjects: Vec<String>,
    /// Paths W changes from HEAD (the work tree's edits).
    pub archived_paths: Vec<String>,
    pub stale_paths: Vec<String>,
    pub private_archived_paths: Vec<PrivatePath>,
    /// What the private files take, in bytes: the private archive's size,
    /// near enough (a dry run says how much room `.salvage/` needs).
    pub private_archive_bytes: u64,
    pub exported_attachments: Vec<ExportedAttachment>,
    /// Chat images a run with `--apply` would export.
    pub attachments_to_export: Vec<String>,
    /// Chat images whose export a rerun may still make (they are in the
    /// private archive meanwhile); they hold up `--remove`.
    pub export_failed: Vec<String>,
    pub skipped_paths: Vec<Skipped>,
    /// W reached canonical only as one rebuilt commit (by the history check
    /// or after the shard's policy refused a path), so canonical lacks the
    /// local history the bundle holds.
    pub history_filtered: bool,
    pub bootstrap_only: bool,
    pub bundle: Option<String>,
    pub private_archive: Option<String>,
    pub clean: bool,
    pub legacy_layout: bool,
    pub no_repository: bool,
    pub canonical_missing: bool,
    /// The target of an entry that is a link (never followed).
    pub link_entry: Option<String>,
    pub notes: Vec<String>,
    pub error: Option<String>,
    pub removed: bool,
    pub would_remove: bool,
    pub remove_refused: Option<String>,
    pub bundle_removed: bool,
    /// The run did everything it does for the entry: with `--apply`, the
    /// salvage ref is verified on canonical when one was due, and the
    /// bundle and the private archive (with every chat image not exported)
    /// are written. Set last, so a run that stopped early (the free-space
    /// floor, any error) leaves it false, and such an entry is never
    /// removed, whatever `--ack` says.
    #[serde(skip)]
    pub finished: bool,
}

/// Counts over one run.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Summary {
    pub dry_run: bool,
    pub entries: usize,
    pub clean: usize,
    pub verified: usize,
    pub open: usize,
    pub removed: usize,
    pub refused: usize,
    pub errors: usize,
    /// Entries with a chat image a rerun may still export.
    pub export_failed: usize,
    /// Bytes of private files over every entry.
    pub private_bytes: u64,
}

impl Summary {
    fn count(&mut self, report: &EntryReport) {
        self.entries += 1;
        if report.error.is_some() {
            self.errors += 1;
        } else if report.clean {
            self.clean += 1;
        } else if report.canonical_verified {
            self.verified += 1;
        } else {
            self.open += 1;
        }
        if report.removed {
            self.removed += 1;
        }
        if report.remove_refused.is_some() {
            self.refused += 1;
        }
        if !report.export_failed.is_empty() {
            self.export_failed += 1;
        }
        self.private_bytes += report.private_archive_bytes;
    }

    pub(crate) fn exit_code(&self) -> i32 {
        i32::from(self.errors > 0 || self.refused > 0 || self.export_failed > 0)
    }

    fn describe(&self) -> String {
        format!(
            "salvage{}: {} entries, {} clean, {} on canonical, {} need review, {} removed, \
             {} not removed, {} failed, {} with chat images not exported, {} bytes of \
             private files",
            if self.dry_run { " (dry run)" } else { "" },
            self.entries,
            self.clean,
            self.verified,
            self.open,
            self.removed,
            self.refused,
            self.errors,
            self.export_failed,
            self.private_bytes
        )
    }
}

/// Salvage every entry under `<root>/.legacy/`, writing one JSON line per
/// entry to `out`.
pub(crate) fn run(
    settings: &Settings,
    services: &dyn Services,
    out: &mut dyn Write,
) -> Result<Summary> {
    let legacy = settings.legacy_dir();
    let mut summary = Summary {
        dry_run: !settings.apply,
        ..Summary::default()
    };
    match std::fs::symlink_metadata(&legacy) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => bail!("{legacy:?} is not a directory (links are never followed)"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(summary),
        Err(error) => return Err(error).with_context(|| format!("failed to inspect {legacy:?}")),
    }
    let _lock = if settings.apply {
        let lock = lock(settings)?;
        // A journal that cannot take a line stops the run before any entry.
        journal::open(settings)?;
        Some(lock)
    } else {
        None
    };
    // The salvage refs earlier runs verified, so a rerun of an entry that
    // holds the same work reports its ref instead of making another.
    let recorded = journal::verified_refs(settings)?;
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&legacy).with_context(|| format!("failed to list {legacy:?}"))? {
        let entry = entry.with_context(|| format!("failed to list {legacy:?}"))?;
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();
    for name in names {
        let project = entry_project(&name);
        if !settings.projects.is_empty()
            && !project.is_some_and(|project| settings.projects.contains(&project))
        {
            continue;
        }
        let report = match project {
            Some(project) => salvage_entry(settings, services, &name, project, recorded.get(&name)),
            None => EntryReport {
                entry: name.clone(),
                node: settings.node.clone(),
                dry_run: !settings.apply,
                notes: vec!["not named like a parked working copy; left as it is".to_string()],
                ..EntryReport::default()
            },
        };
        let line = serde_json::to_string(&report).context("failed to encode a report")?;
        // Stdout first: the entry may be pushed or removed already, so its
        // line must reach the operator even when the journal fails.
        writeln!(out, "{line}").context("failed to write the report")?;
        summary.count(&report);
        if settings.apply {
            // A line the journal could not take stops the run here, before
            // any later entry is pushed or removed.
            journal::append(settings, &line).with_context(|| {
                format!(
                    "{name} was handled (its line is on stdout) but report.jsonl did not take \
                     its line, so the run stopped: {line}"
                )
            })?;
        }
    }
    Ok(summary)
}

/// The space id an entry name starts with: `<id>` or `<id>-<suffix>`, the
/// names the gateway parks folders under.
pub(crate) fn entry_project(name: &str) -> Option<Uuid> {
    let id = name.get(..36)?;
    let parsed = Uuid::parse_str(id).ok()?;
    if parsed.as_hyphenated().to_string() != id {
        return None;
    }
    let rest = &name[36..];
    let suffix_ok = rest.is_empty()
        || rest.strip_prefix('-').is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    suffix_ok.then_some(parsed)
}

/// The run lock, `.salvage/.lock`, held for one run with `--apply`.
struct RunLock(std::fs::File);

impl Drop for RunLock {
    fn drop(&mut self) {
        // Released explicitly: a git process forked meanwhile can hold a
        // copy of the descriptor until it starts, which would otherwise
        // keep the lock past the run.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

fn lock(settings: &Settings) -> Result<RunLock> {
    use fs2::FileExt as _;
    let dir = settings.salvage_dir();
    ensure_private_dir(&dir)?;
    let path = dir.join(".lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .with_context(|| format!("failed to open {path:?}"))?;
    file.try_lock_exclusive()
        .with_context(|| format!("another salvage holds {path:?}"))?;
    Ok(RunLock(file))
}

fn salvage_entry(
    settings: &Settings,
    services: &dyn Services,
    name: &str,
    project: Uuid,
    recorded: Option<&journal::Recorded>,
) -> EntryReport {
    let mut report = EntryReport {
        entry: name.to_string(),
        project: Some(project),
        node: settings.node.clone(),
        dry_run: !settings.apply,
        ..EntryReport::default()
    };
    let path = settings.legacy_dir().join(name);
    let result = match classify::kind_of(&path) {
        Kind::Link => {
            report.link_entry = Some(
                std::fs::read_link(&path)
                    .map(|target| target.to_string_lossy().to_string())
                    .unwrap_or_default(),
            );
            report
                .notes
                .push("a link is never followed: review where it points".to_string());
            report.finished = true;
            Ok(())
        }
        Kind::Folder => {
            repository::salvage_folder(settings, services, &path, project, recorded, &mut report)
        }
        _ => {
            report.notes.push("not a folder".to_string());
            report.finished = true;
            Ok(())
        }
    };
    if let Err(error) = result {
        report.error = Some(format!("{error:#}"));
    }
    if settings.remove {
        remove(settings, &path, &mut report);
    }
    report
}

/// Why an entry may not be removed, if so: never when its run stopped
/// before everything it keeps was written, and otherwise only with `--ack`
/// when something needs review.
fn removal_blocker(settings: &Settings, report: &EntryReport) -> Option<String> {
    if !report.finished {
        return Some(
            "its salvage stopped before everything it keeps for the entry was written and \
             checked, so it is not removed, even with --ack: fix the error, then rerun"
                .to_string(),
        );
    }
    if settings.acks.contains(&report.entry) {
        return None;
    }
    let reason = if report.link_entry.is_some() {
        "it is a link; review its target"
    } else if !report.inspected {
        "it was not inspected"
    } else if report.no_repository {
        "it has no usable repository; its files are in the private archive"
    } else if report
        .skipped_paths
        .iter()
        .any(|skipped| !skipped.rebuildable())
    {
        "paths outside build output were left out"
    } else if !report.export_failed.is_empty() {
        "chat images were not exported (they are in the private archive; a rerun may export \
         them)"
    } else if report.history_filtered {
        "its work reached canonical only as one rebuilt commit; the bundle keeps its local \
         history"
    } else if report.clean || report.canonical_verified {
        return None;
    } else if report.canonical_missing {
        "the space has no canonical repository; only the bundle holds its history"
    } else {
        "its work is not verified on canonical"
    };
    Some(format!(
        "{reason}: review it, then pass --ack {}",
        report.entry
    ))
}

fn remove(settings: &Settings, path: &Path, report: &mut EntryReport) {
    if let Some(reason) = removal_blocker(settings, report) {
        report.remove_refused = Some(reason);
        return;
    }
    if !settings.apply {
        report.would_remove = true;
        return;
    }
    let result = (|| -> Result<()> {
        // Out of `.legacy/` first, so a deletion that stops partway never
        // leaves a half-removed entry that a later run would salvage.
        let trash = settings.salvage_dir().join("trash");
        ensure_private_dir(&trash)?;
        let target = trash.join(format!("{}-{}", report.entry, Uuid::new_v4().simple()));
        rename_no_replace(path, &target)
            .with_context(|| format!("failed to move {path:?} out of .legacy"))?;
        report.removed = true;
        remove_entry(&target).with_context(|| format!("failed to delete {target:?}"))?;
        // Only when canonical holds the raw history the bundle has.
        if report.canonical_verified && !report.history_filtered {
            if let Some(bundle) = report.bundle.as_deref() {
                std::fs::remove_file(bundle)
                    .with_context(|| format!("failed to delete {bundle:?}"))?;
                report.bundle_removed = true;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        report.remove_refused = Some(format!("{error:#}"));
    }
}
