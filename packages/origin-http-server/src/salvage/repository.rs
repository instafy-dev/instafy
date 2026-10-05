//! One parked working copy: its repository checked and read, W built and
//! filtered, chat images exported, and the salvage ref pushed and verified.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{bail, Context, Result};
use git_service::policy::{is_salvage_ref_name, SALVAGE_GATEWAY_REF_ROOT};
use uuid::Uuid;

use super::canonical::{self, Canonical, Pushed};
use super::classify::{self, Kind, PrivatePath, Skipped, Sorted};
use super::options::Settings;
use super::outputs::{
    read_blob, read_worktree_file, write_bundle, write_private_archive, ArchiveItem, Bundled,
};
use super::services::{ExportOutcome, Services};
use super::work::{self, Version, WorkIndex};
use super::{EntryReport, ExportedAttachment};
use crate::hosted::{rename_no_replace, tree_size};
use crate::publish_policy::RejectReason;
use crate::tree_merge::changed_paths;
use crate::workspace_git::WorkspaceGit;

/// Git in a parked entry's repository: every salvage command, so the
/// history checks read the objects a push sends. Replacement refs are
/// ignored whatever ref storage holds them (reftable keeps them out of
/// `refs/replace` and `packed-refs`).
pub(super) fn entry_git<'a>(root: &'a Path, token: Option<&'a str>) -> WorkspaceGit<'a> {
    WorkspaceGit::new(root, token).without_replace_objects()
}

/// Pushes of one entry that the shard's path policy may refuse.
const MAX_POLICY_RETRIES: usize = 8;
/// Rounds of history filtering before giving up on an entry.
const MAX_FILTER_ROUNDS: usize = 4;
/// Subjects of local commits listed per entry.
const MAX_SUBJECTS: usize = 200;
const BOOTSTRAP_SUBJECT: &str = "instafy: bootstrap project memory";

pub(super) fn salvage_folder(
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
/// repository's objects or history, or make what the checks read differ
/// from what a push sends (replacement refs in files or `packed-refs`; any
/// others, such as reftable's, are ignored by [`entry_git`]).
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
    let packed_replace = std::fs::read(git_dir.join("packed-refs"))
        .map(|packed| {
            packed
                .windows(b" refs/replace/".len())
                .any(|window| window == b" refs/replace/")
        })
        .unwrap_or(false);
    if classify::kind_of(&git_dir.join("refs/replace")) != Kind::Missing || packed_replace {
        return Some("its repository has replacement refs, which git is never run with".into());
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
    let git = entry_git(root, read_token.as_deref());
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
                });
                continue;
            }
            ExportOutcome::Kept(why) => {
                report.notes.push(format!("{path} was not exported: {why}"));
            }
            ExportOutcome::Failed(why) => {
                report
                    .notes
                    .push(format!("{path} was not exported (a rerun may): {why}"));
                report.export_failed.push(path.clone());
            }
        }
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
        let pusher = entry_git(push.root, Some(&token));
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
