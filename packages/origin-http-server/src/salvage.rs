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
//!    config reduced to data-only settings, protocols pinned. Canonical `main`
//!    is fetched from the computed URL `<ORIGIN_GIT_REMOTE_BASE_URL>/<id>.git`,
//!    never the entry's own remote, with every received object checked, under
//!    a `git.read` credential the controller mints for the gateway's internal
//!    token. A missing repository is `canonicalMissing`.
//! 3. Changed, untracked and ignored paths are sorted ([`classify`]): stale
//!    copies of versions `main` already has are left out (`stalePaths`);
//!    ignored files, credentials and merge snapshots go to the owner-only
//!    archive; root `chat-upload-*` images are exported to the conversations
//!    that name them (and archived when they cannot be); build output, deny
//!    listed paths, files over 20 MiB and anything git cannot store are
//!    `skippedPaths`; the rest goes into W.
//! 4. W is HEAD plus those paths, committed under the gateway's identity at
//!    HEAD's commit date, so a rerun makes the same commit. Every commit
//!    canonical lacks, and W's whole change, is checked with the publish
//!    rules; with any hit, W becomes one commit on the last shared commit
//!    with those paths as `main` has them, and their local versions go to
//!    the private archive (`historyFiltered`).
//! 5. When W is not on `main`, it is pushed create-only to
//!    `refs/instafy/salvage/gateway/<node>-<W[:8]>` with a `git.salvage`
//!    credential, then read back with `git.read` (`canonicalVerified`). An
//!    existing ref with the same tip is reported as verified; one with
//!    another tip stops the entry. A path the shard's policy refuses is left
//!    as `main` has it and the push is tried again (at most 8 times); any
//!    salvage refusal is final.
//! 6. `.salvage/<entry>.bundle` holds the entry's local history (all of it
//!    when canonical is missing), `.salvage/<entry>.private.tar` (0600) the
//!    private files, and `.salvage/report.jsonl` one line per entry and run.
//!
//! Without `--apply` nothing is pushed, minted for writing, exported, or
//! written under `.salvage/`, and no file of an entry's work tree changes;
//! each entry is still fetched into its own repository and W's objects are
//! written there, so the report can name W. `--remove` (with `--apply`)
//! deletes an entry only when it was clean, or canonical now holds its
//! salvage ref at W and nothing was skipped outside build output, or the
//! entry is named with `--ack`. Salvage refs and private archives are never
//! removed; a bundle only once its ref is verified on canonical.

mod archive;
mod canonical;
mod classify;
mod options;
mod services;
#[cfg(test)]
mod tests;
mod work;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use git_service::policy::{is_salvage_ref_name, SALVAGE_GATEWAY_REF_ROOT};
use serde::Serialize;
use uuid::Uuid;

use self::archive::{EntryData, TarWriter};
use self::canonical::{Canonical, Pushed, FETCHED_MAIN};
use self::classify::{Kind, PrivatePath, Skipped, Sorted};
use self::options::Settings;
use self::services::{ExportOutcome, ExportedTo, Services};
use self::work::{Version, WorkIndex};
use crate::hosted::{ensure_private_dir, remove_entry, rename_no_replace, tree_size};
use crate::publish_policy::RejectReason;
use crate::tree_merge::changed_paths;
use crate::workspace_fs::WorkspaceDir;
use crate::workspace_git::WorkspaceGit;

pub(crate) use self::work::PRIVATE_PATH_TRAILER;

/// Pushes of one entry that the shard's path policy may refuse.
const MAX_POLICY_RETRIES: usize = 8;
/// Rounds of history filtering before giving up on an entry.
const MAX_FILTER_ROUNDS: usize = 4;
/// Subjects of local commits listed per entry.
const MAX_SUBJECTS: usize = 200;
const BOOTSTRAP_SUBJECT: &str = "instafy: bootstrap project memory";
/// Local refs the bundle names besides the salvage ref.
const LOCAL_HEAD_REF: &str = "refs/instafy/salvage-local/head";
const LOCAL_WORK_REF: &str = "refs/instafy/salvage-local/work";

/// Run the subcommand with the arguments after `salvage`; returns the exit
/// status: 0 when every entry was handled, 1 when an entry failed or was not
/// removed, 2 for a usage or configuration error.
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
    pub salvage_ref: Option<String>,
    pub salvage_rev: Option<String>,
    pub canonical_verified: bool,
    pub local_only_commits: usize,
    pub subjects: Vec<String>,
    /// Paths W changes from HEAD (the work tree's edits).
    pub archived_paths: Vec<String>,
    pub stale_paths: Vec<String>,
    pub private_archived_paths: Vec<PrivatePath>,
    pub exported_attachments: Vec<ExportedAttachment>,
    /// Chat images a run with `--apply` would export.
    pub attachments_to_export: Vec<String>,
    pub skipped_paths: Vec<Skipped>,
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
    }

    pub(crate) fn exit_code(&self) -> i32 {
        i32::from(self.errors > 0 || self.refused > 0)
    }

    fn describe(&self) -> String {
        format!(
            "salvage{}: {} entries, {} clean, {} on canonical, {} need review, {} removed, \
             {} not removed, {} failed",
            if self.dry_run { " (dry run)" } else { "" },
            self.entries,
            self.clean,
            self.verified,
            self.open,
            self.removed,
            self.refused,
            self.errors
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
        Some(lock(settings)?)
    } else {
        None
    };
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
            Some(project) => salvage_entry(settings, services, &name, project),
            None => EntryReport {
                entry: name.clone(),
                node: settings.node.clone(),
                dry_run: !settings.apply,
                notes: vec!["not named like a parked working copy; left as it is".to_string()],
                ..EntryReport::default()
            },
        };
        let line = serde_json::to_string(&report).context("failed to encode a report")?;
        if settings.apply {
            append_report(settings, &line)?;
        }
        writeln!(out, "{line}").context("failed to write the report")?;
        summary.count(&report);
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

fn lock(settings: &Settings) -> Result<std::fs::File> {
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
    Ok(file)
}

fn append_report(settings: &Settings, line: &str) -> Result<()> {
    let path = settings.salvage_dir().join("report.jsonl");
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .with_context(|| format!("failed to open {path:?}"))?;
    writeln!(file, "{line}")
        .and_then(|()| file.sync_all())
        .with_context(|| format!("failed to append to {path:?}"))
}

fn salvage_entry(
    settings: &Settings,
    services: &dyn Services,
    name: &str,
    project: Uuid,
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
            Ok(())
        }
        Kind::Folder => salvage_folder(settings, services, &path, project, &mut report),
        _ => {
            report.notes.push("not a folder".to_string());
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

/// Why an entry may not be removed without `--ack`, if so.
fn removal_blocker(settings: &Settings, report: &EntryReport) -> Option<String> {
    if settings.acks.contains(&report.entry) {
        return None;
    }
    let reason = if report.error.is_some() {
        "its salvage did not finish"
    } else if report.link_entry.is_some() {
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
        if report.canonical_verified {
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

fn salvage_folder(
    settings: &Settings,
    services: &dyn Services,
    root: &Path,
    project: Uuid,
    report: &mut EntryReport,
) -> Result<()> {
    let instafy_git = root.join(".instafy/.git");
    let plain_git = root.join(".git");
    let mut unusable = None;
    match (
        classify::kind_of(&instafy_git),
        classify::kind_of(&plain_git),
    ) {
        (Kind::Folder, other) => {
            if other != Kind::Missing {
                report.skipped_paths.push(Skipped {
                    path: ".git/".to_string(),
                    size: tree_size(&plain_git),
                    reason: "unsupported",
                });
                report
                    .notes
                    .push("a second git directory (.git) was left as it is".to_string());
            }
        }
        (Kind::Missing, Kind::Folder) => {
            report.legacy_layout = true;
            if !settings.apply {
                report
                    .notes
                    .push("its .git is moved to .instafy/.git, and read, only with --apply".into());
                return Ok(());
            }
            move_plain_git(root)?;
        }
        (Kind::Missing, Kind::Missing) => unusable = Some("it has no git directory".to_string()),
        _ => unusable = Some("its git directory is a link or a file".to_string()),
    }
    if unusable.is_none() {
        unusable = repository_problem(&instafy_git);
    }
    report.inspected = true;
    match unusable {
        Some(reason) => salvage_files_only(settings, root, &reason, report),
        None => salvage_repository(settings, services, root, project, report),
    }
}

/// Move a plain `.git` to `.instafy/.git` inside the entry, never replacing
/// anything and never following a link.
fn move_plain_git(root: &Path) -> Result<()> {
    let instafy = root.join(".instafy");
    match classify::kind_of(&instafy) {
        Kind::Missing => std::fs::create_dir(&instafy)
            .with_context(|| format!("failed to create {instafy:?}"))?,
        Kind::Folder => {}
        _ => bail!("{instafy:?} is not a folder"),
    }
    rename_no_replace(&root.join(".git"), &instafy.join(".git"))
        .with_context(|| format!("failed to move .git to .instafy/.git in {root:?}"))
}

/// Why git must not run in the repository at `git_dir`, if so: its parts
/// must be real files and folders, and nothing may point git at another
/// repository's objects or history.
fn repository_problem(git_dir: &Path) -> Option<String> {
    for (name, folder) in [("HEAD", false), ("objects", true), ("refs", true)] {
        let kind = classify::kind_of(&git_dir.join(name));
        let fine = if folder {
            kind == Kind::Folder
        } else {
            matches!(kind, Kind::File { .. })
        };
        if !fine {
            return Some(format!(
                "its repository's {name} is missing or not a real one"
            ));
        }
    }
    for name in ["config", "packed-refs"] {
        let kind = classify::kind_of(&git_dir.join(name));
        if !matches!(kind, Kind::File { .. } | Kind::Missing) {
            return Some(format!("its repository's {name} is not a regular file"));
        }
    }
    for name in [
        "commondir",
        "objects/info/alternates",
        "objects/info/http-alternates",
        "info/grafts",
    ] {
        if classify::kind_of(&git_dir.join(name)) != Kind::Missing {
            return Some(format!(
                "its repository has {name}, which git is never run with"
            ));
        }
    }
    None
}

/// An entry without a usable repository: every file goes to the private
/// archive.
fn salvage_files_only(
    settings: &Settings,
    root: &Path,
    reason: &str,
    report: &mut EntryReport,
) -> Result<()> {
    report.no_repository = true;
    report.notes.push(reason.to_string());
    let mut sorted = Sorted::default();
    classify::walk_private(root, "", "no_repository", &mut sorted);
    if classify::kind_of(&root.join(".instafy/.git")) != Kind::Missing {
        sorted.skipped.push(Skipped {
            path: ".instafy/.git/".to_string(),
            size: tree_size(&root.join(".instafy/.git")),
            reason: "unsupported",
        });
    }
    report.skipped_paths.extend(sorted.skipped);
    let items: Vec<ArchiveItem> = sorted
        .private
        .iter()
        .map(|kept| ArchiveItem::Worktree(kept.path.clone()))
        .collect();
    report.private_archived_paths = sorted.private;
    if settings.apply {
        report.private_archive =
            write_private_archive(settings, root, None, &report.entry, &items)?;
    }
    Ok(())
}

fn salvage_repository(
    settings: &Settings,
    services: &dyn Services,
    root: &Path,
    project: Uuid,
    report: &mut EntryReport,
) -> Result<()> {
    let read_token = services.read_token(&project)?;
    let git = WorkspaceGit::new(root, read_token.as_deref());
    let url = settings.remote_url(&project);
    let canonical = canonical::fetch_main(&git, &url)?;
    report.canonical_missing = canonical == Canonical::Missing;
    let main = match &canonical {
        Canonical::Main(main) => Some(main.clone()),
        _ => None,
    };
    let head = git.commit_id("HEAD")?;
    report.head = head.clone();
    if let Some(head) = head.as_deref() {
        let (count, subjects) = local_commits(&git, head, main.as_deref())?;
        report.local_only_commits = count;
        report.subjects = subjects;
    }

    // What the work tree holds, sorted.
    let (listed, unreadable) = classify::candidates(&git)?;
    let mut sorted = classify::sort(root, &listed);
    for name in unreadable {
        sorted.skipped.push(Skipped {
            path: name,
            size: 0,
            reason: "unsupported",
        });
    }
    let index = WorkIndex::new(&git, head.as_deref())?;
    let refused = index.take_from_worktree(&git, &sorted.work)?;
    if !refused.is_empty() {
        sorted.work.retain(|path| !refused.contains(path));
        sorted
            .skipped
            .extend(refused.into_iter().map(|path| Skipped {
                path,
                size: 0,
                reason: "unsupported",
            }));
    }
    report.skipped_paths.append(&mut sorted.skipped);
    let current = index.entries(&git, &sorted.work)?;
    let stale = match main.as_deref() {
        Some(main) => classify::stale_paths(&git, root, main, &current)?,
        None => BTreeSet::new(),
    };
    let stale: Vec<String> = stale.into_iter().collect();
    index.reset(&git, head.as_deref(), &stale)?;
    report.stale_paths = stale;

    // W: HEAD with the work tree's edits.
    let tree = index.write_tree(&git)?;
    let head_tree = match head.as_deref() {
        Some(head) => git.tree_id(head)?,
        None => git.empty_tree()?,
    };
    let date = work::committer_date(&git, head.as_deref())?;
    let work_paths = changed_paths(&git, &head_tree, &tree)?;
    let raw_tip = if tree == head_tree {
        head.clone()
    } else {
        Some(work::commit(
            &git,
            &tree,
            head.as_deref(),
            &settings.identity,
            &date,
            &work::message(&work_paths, &sorted.private),
        )?)
    };
    report.archived_paths = work_paths.clone();

    // Private files and chat images of the work tree.
    let mut items: Vec<ArchiveItem> = sorted
        .private
        .iter()
        .map(|kept| ArchiveItem::Worktree(kept.path.clone()))
        .collect();
    let mut private = sorted.private.clone();
    let mut attachments: Vec<(String, AttachmentSource)> = sorted
        .attachments
        .iter()
        .map(|path| (path.clone(), AttachmentSource::Worktree))
        .collect();

    let on_main = |tip: Option<&str>| -> Result<bool> {
        Ok(match (tip, main.as_deref()) {
            (None, _) => true,
            (Some(tip), Some(main)) => git.is_ancestor(tip, main)?,
            (Some(_), None) => false,
        })
    };

    // The history check: what may go to canonical as it is.
    let mut tip = raw_tip.clone();
    let mut filtered: BTreeMap<String, RejectReason> = BTreeMap::new();
    if !on_main(raw_tip.as_deref())? && canonical != Canonical::Missing {
        let raw = raw_tip.clone().context("a tip off main must exist")?;
        let mut scanned = work::scan(&git, &raw, main.as_deref())?;
        let mut touched: BTreeSet<String> = scanned.touched.clone();
        touched.extend(work_paths.iter().cloned());
        report.bootstrap_only = bootstrap_only(&touched, report);
        let mut rounds = 0;
        loop {
            // A path already filtered holds `main`'s own version, which is
            // no leak even where `main` changed it since the shared commit.
            let fresh: Vec<(String, work::Hit)> = std::mem::take(&mut scanned.hits)
                .into_iter()
                .filter(|(path, _)| !filtered.contains_key(path))
                .collect();
            if fresh.is_empty() {
                break;
            }
            rounds += 1;
            if rounds > MAX_FILTER_ROUNDS {
                bail!("the salvage commit still holds unpublishable paths after filtering");
            }
            report.history_filtered = true;
            for (path, hit) in fresh {
                filtered.insert(path.clone(), hit.reason);
                keep_history(
                    &path,
                    hit.reason,
                    &hit.versions,
                    &mut items,
                    &mut private,
                    &mut report.skipped_paths,
                    &git,
                )?;
                if hit.reason == RejectReason::Attachment && classify::is_root_chat_upload(&path) {
                    // A chat image only a local commit holds: export the
                    // version HEAD has, unless the work tree's copy goes.
                    if !attachments.iter().any(|(known, _)| known == &path) {
                        if let Some(version) = head
                            .as_deref()
                            .map(|head| git.tree_entries(head, std::slice::from_ref(&path)))
                            .transpose()?
                            .and_then(|mut entries| entries.remove(&path))
                        {
                            attachments.push((path.clone(), AttachmentSource::Blob(version.oid)));
                        }
                    }
                }
            }
            let keys: Vec<String> = filtered.keys().cloned().collect();
            tip = work::squash(
                &git,
                &raw,
                main.as_deref(),
                &keys,
                &settings.identity,
                &date,
                &private,
            )?;
            scanned = match tip.as_deref() {
                Some(next) if !on_main(Some(next))? => work::scan(&git, next, main.as_deref())?,
                _ => work::Scan::default(),
            };
        }
    }

    // What the salvage commit's trailers name; images that cannot be
    // exported are archived too, but never named there, so a rerun after an
    // export that failed makes the same commit.
    let trailer_private = private.clone();

    // Chat images: exported with --apply, archived when they cannot be.
    for (path, source) in attachments {
        if !settings.apply {
            report.attachments_to_export.push(path);
            continue;
        }
        let bytes = match &source {
            AttachmentSource::Worktree => read_worktree_file(root, &path)?.0,
            AttachmentSource::Blob(oid) => read_blob(&git, oid)?,
        };
        match services.export_attachment(&project, &path, bytes) {
            ExportOutcome::Exported(conversations) => {
                report.exported_attachments.push(ExportedAttachment {
                    path,
                    conversations,
                })
            }
            ExportOutcome::Kept(why) => {
                report.notes.push(format!("{path} was not exported: {why}"));
                items.push(match source {
                    AttachmentSource::Worktree => ArchiveItem::Worktree(path.clone()),
                    AttachmentSource::Blob(ref oid) => ArchiveItem::Blob {
                        commit: head.clone().unwrap_or_default(),
                        path: path.clone(),
                        oid: oid.clone(),
                        link: false,
                        executable: false,
                    },
                });
                private.push(PrivatePath {
                    path,
                    reason: "attachment",
                    commit: match source {
                        AttachmentSource::Worktree => None,
                        AttachmentSource::Blob(_) => head.clone(),
                    },
                });
            }
        }
    }

    // Canonical. The bundle and the private archive are written whatever
    // the push did.
    let mut nothing_to_push = on_main(tip.as_deref())?;
    let pushed = if nothing_to_push || canonical == Canonical::Missing {
        Ok(())
    } else {
        let mut push = PushState {
            git: &git,
            root,
            url: &url,
            project,
            raw: raw_tip.as_deref(),
            main: main.as_deref(),
            date: &date,
            private: &trailer_private,
            filtered: &mut filtered,
        };
        push_salvage_ref(settings, services, &mut push, &mut tip, report).map(|landed| {
            if !landed {
                nothing_to_push = true;
            }
        })
    };

    report.clean = nothing_to_push
        && (canonical != Canonical::Missing || tip.is_none())
        && report.skipped_paths.iter().all(Skipped::rebuildable);
    report.private_archived_paths = private;
    if settings.apply {
        report.bundle = write_bundle(
            settings,
            &git,
            &report.entry,
            &Bundled {
                head: head.as_deref(),
                raw: raw_tip.as_deref(),
                pushed: report.salvage_ref.as_deref().zip(tip.as_deref()),
                main: main.as_deref(),
            },
        )?;
        report.private_archive =
            write_private_archive(settings, root, Some(&git), &report.entry, &items)?;
    }
    pushed
}

/// What pushing one entry's salvage ref needs.
struct PushState<'a, 'g> {
    git: &'a WorkspaceGit<'g>,
    root: &'a Path,
    url: &'a str,
    project: Uuid,
    raw: Option<&'a str>,
    main: Option<&'a str>,
    date: &'a str,
    private: &'a [PrivatePath],
    filtered: &'a mut BTreeMap<String, RejectReason>,
}

/// Create the salvage ref for `tip` on canonical (or find it there), and
/// verify it. A path the shard's policy refuses is left as `main` has it and
/// `tip` is rebuilt. Returns false when nothing is left to push.
fn push_salvage_ref(
    settings: &Settings,
    services: &dyn Services,
    push: &mut PushState<'_, '_>,
    tip: &mut Option<String>,
    report: &mut EntryReport,
) -> Result<bool> {
    let git = push.git;
    let mut refusals = 0;
    loop {
        let current = tip.clone().context("a tip off main must exist")?;
        let reference = salvage_ref(&settings.node, &current)?;
        report.salvage_ref = Some(reference.clone());
        report.salvage_rev = Some(current.clone());
        match canonical::salvage_tip(git, push.url, &reference)? {
            Some(rev) if rev == current => {
                report.canonical_verified = true;
                return Ok(true);
            }
            Some(rev) => bail!(
                "{reference} already names {rev} on canonical, not {current}: an operator must \
                 decide"
            ),
            None if !settings.apply => return Ok(true),
            None => {}
        }
        let token = services.salvage_token(&push.project)?;
        let pusher = WorkspaceGit::new(push.root, Some(&token));
        match canonical::create_salvage_ref(&pusher, push.url, &current, &reference)? {
            Pushed::Created => {
                if canonical::salvage_tip(git, push.url, &reference)?.as_deref()
                    != Some(current.as_str())
                {
                    bail!("{reference} was pushed but canonical does not show it at {current}");
                }
                report.canonical_verified = true;
                return Ok(true);
            }
            Pushed::PathRefused { path, reason } => {
                refusals += 1;
                if refusals > MAX_POLICY_RETRIES || push.filtered.contains_key(&path) {
                    bail!("canonical refused {path} again ({})", reason_name(reason));
                }
                push.filtered.insert(path.clone(), RejectReason::Policy);
                report.skipped_paths.push(Skipped {
                    path,
                    size: 0,
                    reason: reason_name(RejectReason::Policy),
                });
                let raw = push.raw.context("a tip off main must exist")?;
                let keys: Vec<String> = push.filtered.keys().cloned().collect();
                *tip = work::squash(
                    git,
                    raw,
                    push.main,
                    &keys,
                    &settings.identity,
                    push.date,
                    push.private,
                )?;
                let left = match (tip.as_deref(), push.main) {
                    (None, _) => false,
                    (Some(next), Some(main)) => !git.is_ancestor(next, main)?,
                    (Some(_), None) => true,
                };
                if !left {
                    report.salvage_ref = None;
                    report.salvage_rev = None;
                    return Ok(false);
                }
                // The rebuilt commit only takes `main`'s versions of paths;
                // check it like every commit that goes to canonical.
                let next = tip.as_deref().context("a tip off main must exist")?;
                let rescan = work::scan(git, next, push.main)?;
                if rescan
                    .hits
                    .keys()
                    .any(|path| !push.filtered.contains_key(path))
                {
                    bail!("the rebuilt salvage commit holds unpublishable paths");
                }
            }
            Pushed::Failed(text) => {
                // An unknown outcome may still have landed.
                if canonical::salvage_tip(git, push.url, &reference)?.as_deref()
                    == Some(current.as_str())
                {
                    report.canonical_verified = true;
                    return Ok(true);
                }
                bail!("{text}");
            }
        }
    }
}

/// `refs/instafy/salvage/gateway/<node>-<W[:8]>`, checked against the
/// shard's own rule.
fn salvage_ref(node: &str, tip: &str) -> Result<String> {
    let reference = format!(
        "{SALVAGE_GATEWAY_REF_ROOT}/{node}-{}",
        &tip[..8.min(tip.len())]
    );
    if !is_salvage_ref_name(&reference) {
        bail!("{reference} is not a valid salvage ref name");
    }
    Ok(reference)
}

/// How many commits HEAD has that `main` lacks, and their subjects.
fn local_commits(
    git: &WorkspaceGit<'_>,
    head: &str,
    main: Option<&str>,
) -> Result<(usize, Vec<String>)> {
    let not_main = main.map(|main| format!("^{main}"));
    let mut count_args = vec!["rev-list", "--count", head];
    count_args.extend(not_main.as_deref());
    let count = git
        .stdout(&count_args)?
        .trim()
        .parse()
        .context("rev-list printed no count")?;
    let limit = MAX_SUBJECTS.to_string();
    let mut log_args = vec!["log", "--format=%s", "-n", &limit, head];
    log_args.extend(not_main.as_deref());
    let subjects = git.stdout(&log_args)?.lines().map(str::to_string).collect();
    Ok((count, subjects))
}

/// Only the project-memory bootstrap wrote here: every changed path is one of
/// its files and every local commit is its own.
fn bootstrap_only(touched: &BTreeSet<String>, report: &EntryReport) -> bool {
    let bootstrap_path = |path: &str| {
        matches!(
            path,
            "INSTAFY.md"
                | "AGENTS.md"
                | "CLAUDE.md"
                | "AGENTS.py"
                | ".agents/.instafy-managed-defaults-state.json"
        ) || path.starts_with(".agents/skills/instafy-")
    };
    !touched.is_empty()
        && touched.iter().all(|path| bootstrap_path(path))
        && report.subjects.len() == report.local_only_commits
        && report
            .subjects
            .iter()
            .all(|subject| subject == BOOTSTRAP_SUBJECT)
}

/// Where an exported chat image's bytes come from.
enum AttachmentSource {
    Worktree,
    Blob(String),
}

/// One file of the private archive.
enum ArchiveItem {
    Worktree(String),
    Blob {
        commit: String,
        path: String,
        oid: String,
        link: bool,
        executable: bool,
    },
}

/// Keep a path a local commit held and canonical may not take: its versions
/// go to the private archive, or, for build output, deny-listed and
/// oversized paths, it is reported as skipped.
fn keep_history(
    path: &str,
    reason: RejectReason,
    versions: &[Version],
    items: &mut Vec<ArchiveItem>,
    private: &mut Vec<PrivatePath>,
    skipped: &mut Vec<Skipped>,
    git: &WorkspaceGit<'_>,
) -> Result<()> {
    match reason {
        RejectReason::Excluded | RejectReason::TooLarge | RejectReason::Policy => {
            let ids: Vec<String> = versions.iter().map(|version| version.oid.clone()).collect();
            let size = git
                .object_sizes(&ids)?
                .into_iter()
                .flatten()
                .map(|(_, size)| size)
                .max()
                .unwrap_or(0);
            skipped.push(Skipped {
                path: path.to_string(),
                size,
                reason: match reason {
                    RejectReason::TooLarge => "too_large",
                    _ => "excluded",
                },
            });
        }
        _ if versions.is_empty() => skipped.push(Skipped {
            path: path.to_string(),
            size: 0,
            reason: reason_name(reason),
        }),
        _ => {
            for version in versions {
                items.push(ArchiveItem::Blob {
                    commit: version.commit.clone(),
                    path: path.to_string(),
                    oid: version.oid.clone(),
                    link: version.mode == "120000",
                    executable: version.mode == "100755",
                });
                private.push(PrivatePath {
                    path: path.to_string(),
                    reason: reason_name(reason),
                    commit: Some(version.commit.clone()),
                });
            }
        }
    }
    Ok(())
}

fn reason_name(reason: RejectReason) -> &'static str {
    match reason {
        RejectReason::Excluded => "excluded",
        RejectReason::Secret => "secret",
        RejectReason::Attachment => "attachment",
        RejectReason::Ignored => "ignored",
        RejectReason::TooLarge => "too_large",
        RejectReason::Policy => "policy",
        RejectReason::Unsupported => "unsupported",
    }
}

/// A work-tree file read without following any link: its bytes and whether
/// it is executable.
fn read_worktree_file(root: &Path, path: &str) -> Result<(Vec<u8>, bool)> {
    use std::io::Read as _;
    let workspace = WorkspaceDir::open(root).with_context(|| format!("failed to open {root:?}"))?;
    let mut file = workspace
        .open_file(path)
        .with_context(|| format!("failed to open {path:?} without following links"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {path:?}"))?;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt as _;
        file.metadata()?.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Ok((bytes, executable))
}

fn read_blob(git: &WorkspaceGit<'_>, oid: &str) -> Result<Vec<u8>> {
    Ok(git
        .read_objects(&[oid.to_string()])?
        .pop()
        .context("blob missing")?
        .data)
}

/// Write the private archive, never replacing an earlier one: the same
/// content is kept once, and different content gets a name of its own.
fn write_private_archive(
    settings: &Settings,
    root: &Path,
    git: Option<&WorkspaceGit<'_>>,
    entry: &str,
    items: &[ArchiveItem],
) -> Result<Option<String>> {
    if items.is_empty() {
        return Ok(None);
    }
    let dir = settings.salvage_dir();
    ensure_private_dir(&dir)?;
    let temp = dir.join(format!(".tmp-{}.tar", Uuid::new_v4().simple()));
    let result = (|| -> Result<PathBuf> {
        let mut writer = TarWriter::create(&temp)?;
        for item in items {
            match item {
                ArchiveItem::Worktree(path) => {
                    let name = format!("worktree/{path}");
                    match classify::kind_of(&root.join(path)) {
                        Kind::Link => {
                            let target = std::fs::read_link(root.join(path))
                                .with_context(|| format!("failed to read the link {path:?}"))?;
                            writer.append(
                                &name,
                                &EntryData::Link {
                                    target: target.to_string_lossy().as_bytes().to_vec(),
                                },
                            )?;
                        }
                        _ => {
                            let (bytes, executable) = read_worktree_file(root, path)?;
                            writer.append(&name, &EntryData::File { bytes, executable })?;
                        }
                    }
                }
                ArchiveItem::Blob {
                    commit,
                    path,
                    oid,
                    link,
                    executable,
                } => {
                    let git = git.context("history items need the repository")?;
                    let bytes = read_blob(git, oid)?;
                    let name = format!("history/{commit}/{path}");
                    let data = if *link {
                        EntryData::Link { target: bytes }
                    } else {
                        EntryData::File {
                            bytes,
                            executable: *executable,
                        }
                    };
                    writer.append(&name, &data)?;
                }
            }
        }
        writer.finish()?;
        keep_archive(&dir, entry, &temp)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map(|path| Some(path.to_string_lossy().to_string()))
}

fn keep_archive(dir: &Path, entry: &str, temp: &Path) -> Result<PathBuf> {
    let target = dir.join(format!("{entry}.private.tar"));
    if classify::kind_of(&target) == Kind::Missing {
        rename_no_replace(temp, &target).with_context(|| format!("failed to keep {target:?}"))?;
        return Ok(target);
    }
    if same_content(&target, temp)? {
        std::fs::remove_file(temp).ok();
        return Ok(target);
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    for n in 1..1000 {
        let other = dir.join(format!("{entry}.private-{stamp}-{n}.tar"));
        match rename_no_replace(temp, &other) {
            Ok(()) => return Ok(other),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).with_context(|| format!("failed to keep {other:?}")),
        }
    }
    bail!("no free name for another private archive of {entry}")
}

fn same_content(a: &Path, b: &Path) -> Result<bool> {
    use sha2::{Digest as _, Sha256};
    let digest = |path: &Path| -> Result<Vec<u8>> {
        let mut file =
            std::fs::File::open(path).with_context(|| format!("failed to read {path:?}"))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)?;
        Ok(hasher.finalize().to_vec())
    };
    Ok(digest(a)? == digest(b)?)
}

/// What the bundle holds.
struct Bundled<'a> {
    head: Option<&'a str>,
    /// W before any filtering.
    raw: Option<&'a str>,
    /// The salvage ref and the commit it names.
    pushed: Option<(&'a str, &'a str)>,
    main: Option<&'a str>,
}

/// `<entry>.bundle`: the entry's history canonical lacks (all of it without
/// canonical `main`), under local refs of the entry's own repository.
fn write_bundle(
    settings: &Settings,
    git: &WorkspaceGit<'_>,
    entry: &str,
    bundled: &Bundled<'_>,
) -> Result<Option<String>> {
    let mut refs: Vec<(String, String)> = Vec::new();
    if let Some((reference, tip)) = bundled.pushed {
        refs.push((reference.to_string(), tip.to_string()));
    }
    if let Some(head) = bundled.head {
        refs.push((LOCAL_HEAD_REF.to_string(), head.to_string()));
    }
    if let Some(raw) = bundled.raw.filter(|raw| Some(*raw) != bundled.head) {
        refs.push((LOCAL_WORK_REF.to_string(), raw.to_string()));
    }
    let mut needed = Vec::new();
    for (reference, tip) in refs {
        let on_main = match bundled.main {
            Some(main) => git.is_ancestor(&tip, main)?,
            None => false,
        };
        if !on_main && !needed.iter().any(|(known, _)| known == &reference) {
            needed.push((reference, tip));
        }
    }
    if needed.is_empty() {
        return Ok(None);
    }
    for (reference, tip) in &needed {
        git.ok(&["update-ref", "-m", "instafy: salvage", reference, tip])?;
    }
    let dir = settings.salvage_dir();
    ensure_private_dir(&dir)?;
    let temp = dir.join(format!(".tmp-{}.bundle", Uuid::new_v4().simple()));
    let temp_text = temp.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["bundle", "create", &temp_text];
    args.extend(needed.iter().map(|(reference, _)| reference.as_str()));
    if bundled.main.is_some() {
        args.extend(["--not", FETCHED_MAIN]);
    }
    let created = git.ok(&args);
    if let Err(error) = created {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to restrict {temp:?}"))?;
    }
    let target = dir.join(format!("{entry}.bundle"));
    std::fs::rename(&temp, &target).with_context(|| format!("failed to keep {target:?}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}
