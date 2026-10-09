use std::ffi::OsStr;
use std::fs::File;
use std::path::Path;

use fs2::FileExt;

use crate::error::OriginError;
use crate::safe_fs::{
    create_new_private_options, open_or_create_child, open_workspace_root,
    read_write_nofollow_options, sync_dir,
};

const WORKSPACE_APPLY_LOCK_NAME: &str = "origin-apply.lock";

#[derive(Debug)]
pub struct WorkspaceApplyLock {
    file: File,
}

impl Drop for WorkspaceApplyLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

/// Acquire the process-independent workspace mutation lock. The returned file
/// guard is intentionally movable into `spawn_blocking`; dropping the request
/// future therefore cannot release it while detached blocking work continues.
pub fn try_acquire_workspace_apply_lock(
    workspace_root: &Path,
) -> Result<Option<WorkspaceApplyLock>, OriginError> {
    let workspace = open_workspace_root(workspace_root)
        .map_err(|error| OriginError::bad_request(format!("workspace root is unsafe: {error}")))?;
    let instafy_dir =
        open_or_create_child(&workspace, OsStr::new(".instafy")).map_err(|error| {
            OriginError::bad_request(format!("workspace metadata path is unsafe: {error}"))
        })?;
    let lock_name = OsStr::new(WORKSPACE_APPLY_LOCK_NAME);
    let (file, created) = match instafy_dir.open_with(lock_name, &create_new_private_options()) {
        Ok(file) => (file, true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let file = instafy_dir
                .open_with(lock_name, &read_write_nofollow_options())
                .map_err(|error| {
                    OriginError::internal(format!("failed to open workspace apply lock: {error}"))
                })?;
            (file, false)
        }
        Err(error) => {
            return Err(OriginError::internal(format!(
                "failed to create workspace apply lock: {error}"
            )))
        }
    };
    if !file
        .metadata()
        .map_err(|error| {
            OriginError::internal(format!("failed to inspect workspace apply lock: {error}"))
        })?
        .is_file()
    {
        return Err(OriginError::bad_request(
            "workspace apply lock must be a regular file",
        ));
    }
    let file = file.into_std();
    if created {
        file.sync_all().map_err(|error| {
            OriginError::internal(format!("failed to flush workspace apply lock: {error}"))
        })?;
        sync_dir(&instafy_dir).map_err(|error| {
            OriginError::internal(format!("failed to flush workspace metadata: {error}"))
        })?;
    }

    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => {
            // Whoever takes the workspace may change it, so a durable-stop
            // marker an earlier stop on this folder left (a sibling runtime's,
            // say) no longer holds: only a stop's own durable answer, written
            // while it holds this lock, leaves one behind.
            crate::server::clear_clean_stop_marker(workspace_root);
            Ok(Some(WorkspaceApplyLock { file }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(OriginError::internal(format!(
            "failed to lock workspace for apply: {error}"
        ))),
    }
}

/// [`try_acquire_workspace_apply_lock`], trying again for up to `wait` while
/// another holder has it. `None` once `wait` has passed.
pub fn acquire_workspace_apply_lock_within(
    workspace_root: &Path,
    wait: std::time::Duration,
) -> Result<Option<WorkspaceApplyLock>, OriginError> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Some(lock) = try_acquire_workspace_apply_lock(workspace_root)? {
            return Ok(Some(lock));
        }
        if std::time::Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::try_acquire_workspace_apply_lock;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    #[test]
    fn detached_worker_retains_cross_process_lock_until_mutation_finishes() {
        let workspace = TempDir::new().unwrap();
        let first = try_acquire_workspace_apply_lock(workspace.path())
            .unwrap()
            .expect("first lock");
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            let _guard = first;
            release_rx.recv().unwrap();
        });
        drop(worker);

        assert!(try_acquire_workspace_apply_lock(workspace.path())
            .unwrap()
            .is_none());
        release_tx.send(()).unwrap();

        // The worker lets the lock go when it next runs, which a loaded host
        // can put off for a while: wait for that, within a generous bound.
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if try_acquire_workspace_apply_lock(workspace.path())
                .unwrap()
                .is_some()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("detached worker did not release lock after finishing");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_metadata_or_lock_file_fails_closed() {
        use std::os::unix::fs::symlink;

        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), workspace.path().join(".instafy")).unwrap();
        assert!(try_acquire_workspace_apply_lock(workspace.path()).is_err());
        assert!(!outside.path().join("origin-apply.lock").exists());

        std::fs::remove_file(workspace.path().join(".instafy")).unwrap();
        std::fs::create_dir(workspace.path().join(".instafy")).unwrap();
        let outside_lock = outside.path().join("outside.lock");
        std::fs::write(&outside_lock, b"outside").unwrap();
        symlink(
            &outside_lock,
            workspace.path().join(".instafy/origin-apply.lock"),
        )
        .unwrap();
        assert!(try_acquire_workspace_apply_lock(workspace.path()).is_err());
        assert_eq!(std::fs::read(outside_lock).unwrap(), b"outside");
    }
}
