//! How a folder began a write job's turn, kept until the job ends.
//!
//! A stop (or an expired lease) requeues a job mid-turn, and a later lease
//! may resume it in the folder its cut-off attempt wrote to. To count that
//! attempt's work as the job's own, and nothing else the folder holds (the
//! person's own edits, other turns' unsaved work, the runtime's memory
//! scaffold), a write turn records the folder's `git status` as it begins:
//!
//! - The record lives in the checkout's git directory, which `git status`
//!   never lists and no save publishes. A folder without one of its own (no
//!   repository, or a `.git` file or link) keeps no record, and a fresh
//!   clone or another runtime's folder has none.
//! - A lease that resumes an interrupted attempt reads the job's record
//!   rather than writing one. When there is none, it records the folder as
//!   it finds it, for a later lease.
//! - The job's end removes the record (see `JobProcessor::run_apply_job`),
//!   unless the job lost its lease. A stop that ends the process mid-turn
//!   removes nothing. A job that loses its lease and never comes back here
//!   (a cancelled turn, or one another runtime resumed) leaves its record
//!   until a later record finds it older than [`RECORD_MAX_AGE`].

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::Path;
use std::time::Duration;

use origin_http_server::workspace_fs::WorkspaceDir;
use tracing::warn;
use uuid::Uuid;

use super::workspace_change_detection::GitStatusEntry;

/// The folder, in the checkout's git directory, that holds the records.
const RECORDS_DIR: &str = "instafy-turn-baselines";

/// How long a record outlives its job's last attempt here: far longer than a
/// requeued job waits for its next lease.
const RECORD_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Begins a write turn of job `job_id` in `workspace_dir`, whose `git status`
/// is `status` now. On a lease that resumes an interrupted attempt, returns
/// the status this job's earliest attempt in the folder began with, when it
/// has a record. Otherwise records `status` and returns `None`.
pub(super) fn begin(
    workspace_dir: &Path,
    job_id: Uuid,
    resumes_an_interrupted_attempt: bool,
    status: &HashMap<String, GitStatusEntry>,
) -> Option<HashMap<String, GitStatusEntry>> {
    if resumes_an_interrupted_attempt && let Some(earlier) = read(workspace_dir, job_id) {
        return Some(earlier);
    }
    if let Err(error) = write(workspace_dir, job_id, status) {
        warn!(%job_id, %error, "could not record how the turn's folder began");
    }
    None
}

/// Removes the record of job `job_id`, whose job ended.
pub(super) fn forget(workspace_dir: &Path, job_id: Uuid) {
    let Ok(records) = records(workspace_dir, false) else {
        return;
    };
    match records.remove(&file_name(job_id)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => warn!(%job_id, %error, "could not remove the turn's start record"),
    }
}

fn read(workspace_dir: &Path, job_id: Uuid) -> Option<HashMap<String, GitStatusEntry>> {
    let mut raw = String::new();
    records(workspace_dir, false)
        .and_then(|records| records.open_file(&file_name(job_id)))
        .and_then(|mut file| file.read_to_string(&mut raw))
        .ok()?;
    serde_json::from_str(&raw)
        .inspect_err(|error| warn!(%job_id, %error, "ignoring an unreadable turn start record"))
        .ok()
}

fn write(
    workspace_dir: &Path,
    job_id: Uuid,
    status: &HashMap<String, GitStatusEntry>,
) -> io::Result<()> {
    let raw = serde_json::to_vec(status).map_err(io::Error::other)?;
    let records = records(workspace_dir, true)?;
    remove_stale_records(&records);
    records.replace_file(&file_name(job_id), &mut raw.as_slice(), false)?;
    Ok(())
}

fn remove_stale_records(records: &WorkspaceDir) {
    let Ok(entries) = records.list(None) else {
        return;
    };
    for entry in entries {
        let stale = entry
            .metadata
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > RECORD_MAX_AGE);
        if stale && let Some(name) = entry.name.to_str() {
            let _ = records.remove(name);
        }
    }
}

/// The records folder in the checkout's own git directory. That directory is
/// never created here, and no link on the way is followed.
fn records(workspace_dir: &Path, create: bool) -> io::Result<WorkspaceDir> {
    let git_dir = if super::workspace_uses_instafy_canonical_git(workspace_dir) {
        ".instafy/.git"
    } else {
        ".git"
    };
    let git_dir = WorkspaceDir::open(workspace_dir)?.open_dir(git_dir)?;
    if create {
        git_dir.create_dir_all(RECORDS_DIR)
    } else {
        git_dir.open_dir(RECORDS_DIR)
    }
}

fn file_name(job_id: Uuid) -> String {
    format!("{job_id}.json")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn status(entries: &[(&str, &str, &str)]) -> HashMap<String, GitStatusEntry> {
        entries
            .iter()
            .map(|(path, code, fingerprint)| {
                (
                    path.to_string(),
                    GitStatusEntry::new(*code, Some(fingerprint.to_string())),
                )
            })
            .collect()
    }

    #[test]
    fn a_resumed_lease_reads_how_the_jobs_first_attempt_began_until_the_job_ends() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let job_id = Uuid::new_v4();
        let first = status(&[("notes.md", " M", "a")]);
        let resumed = status(&[("notes.md", " M", "a"), ("ALIAS.md", "??", "b")]);

        // The first lease records the folder; nothing is resumed.
        assert_eq!(begin(workspace.path(), job_id, false, &first), None);
        assert!(
            workspace
                .path()
                .join(".git")
                .join(RECORDS_DIR)
                .join(file_name(job_id))
                .is_file()
        );
        // A resumed lease gets that record back, and keeps it for another.
        assert_eq!(
            begin(workspace.path(), job_id, true, &resumed),
            Some(first.clone())
        );
        assert_eq!(
            begin(workspace.path(), job_id, true, &resumed),
            Some(first.clone())
        );
        // Another job has a record of its own.
        assert_eq!(
            begin(workspace.path(), Uuid::new_v4(), true, &resumed),
            None
        );

        // Once the job ends, a lease finds no record and makes its own.
        forget(workspace.path(), job_id);
        forget(workspace.path(), job_id);
        assert_eq!(begin(workspace.path(), job_id, true, &resumed), None);
        assert_eq!(begin(workspace.path(), job_id, true, &first), Some(resumed));
    }

    #[test]
    fn a_new_record_removes_records_older_than_a_week() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let (stale, recent) = (Uuid::new_v4(), Uuid::new_v4());
        let first = status(&[("ALIAS.md", "??", "a")]);
        assert_eq!(begin(workspace.path(), stale, false, &first), None);
        assert_eq!(begin(workspace.path(), recent, false, &first), None);
        let stale_path = workspace
            .path()
            .join(".git")
            .join(RECORDS_DIR)
            .join(file_name(stale));
        let eight_days_ago = std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
        fs::File::options()
            .write(true)
            .open(&stale_path)
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();

        assert_eq!(begin(workspace.path(), Uuid::new_v4(), false, &first), None);
        assert!(!stale_path.exists());
        assert_eq!(begin(workspace.path(), recent, true, &first), Some(first));
    }

    #[test]
    fn a_first_lease_replaces_a_record_it_finds() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let job_id = Uuid::new_v4();
        let stale = status(&[("old.md", "??", "a")]);
        let now = status(&[]);

        assert_eq!(begin(workspace.path(), job_id, false, &stale), None);
        assert_eq!(begin(workspace.path(), job_id, false, &now), None);
        assert_eq!(begin(workspace.path(), job_id, true, &stale), Some(now));
    }

    #[test]
    fn the_record_lives_in_a_canonical_checkouts_git_directory() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join(".instafy/.git")).unwrap();
        let job_id = Uuid::new_v4();
        let first = status(&[("ALIAS.md", "??", "a")]);

        assert_eq!(begin(workspace.path(), job_id, false, &first), None);
        assert!(
            workspace
                .path()
                .join(".instafy/.git")
                .join(RECORDS_DIR)
                .join(file_name(job_id))
                .is_file()
        );
        assert_eq!(
            begin(workspace.path(), job_id, true, &status(&[])),
            Some(first)
        );
    }

    #[test]
    fn a_folder_without_its_own_git_directory_keeps_no_record() {
        let job_id = Uuid::new_v4();
        let first = status(&[("ALIAS.md", "??", "a")]);

        // No repository here (a parent folder's, say): none is created.
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(begin(plain.path(), job_id, false, &first), None);
        assert!(!plain.path().join(".git").exists());
        assert_eq!(begin(plain.path(), job_id, true, &first), None);

        // A linked worktree's `.git` file.
        let worktree = tempfile::tempdir().unwrap();
        fs::write(worktree.path().join(".git"), "gitdir: elsewhere\n").unwrap();
        assert_eq!(begin(worktree.path(), job_id, false, &first), None);
        assert_eq!(begin(worktree.path(), job_id, true, &first), None);

        // A `.git` link is not followed.
        #[cfg(unix)]
        {
            let linked = tempfile::tempdir().unwrap();
            let target = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(target.path(), linked.path().join(".git")).unwrap();
            assert_eq!(begin(linked.path(), job_id, false, &first), None);
            assert!(!target.path().join(RECORDS_DIR).exists());
        }
    }
}
