use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use uuid::Uuid;

pub fn open_workspace_root(path: &Path) -> io::Result<Dir> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace root must be a real directory",
        ));
    }
    let dir = Dir::open_ambient_dir(path, ambient_authority())?;
    let opened_metadata = dir.try_clone()?.into_std_file().metadata()?;
    if !opened_metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace root changed while it was opened",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened_metadata.dev() || metadata.ino() != opened_metadata.ino() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace root changed while it was opened",
            ));
        }
    }
    Ok(dir)
}

pub fn sync_dir(dir: &Dir) -> io::Result<()> {
    // `cap_std::fs::Dir` deliberately uses `O_PATH` for capability directory
    // handles on Linux. Those handles are valid for relative filesystem
    // operations, but `fsync(2)` rejects them with `EBADF`. Re-open the
    // already-open directory through `.` with a normal readable, no-follow
    // file descriptor before flushing it. This stays capability-relative and
    // cannot be redirected through a path outside `dir`.
    let syncable = dir.open_with(Path::new("."), &read_nofollow_options())?;
    if !syncable.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory sync target is not a directory",
        ));
    }
    syncable.sync_all()
}

pub fn open_or_create_child(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    match parent.open_dir_nofollow(name) {
        Ok(dir) => Ok(dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let created = match parent.create_dir(name) {
                Ok(()) => true,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
                Err(error) => return Err(error),
            };
            let child = parent.open_dir_nofollow(name)?;
            if created {
                sync_dir(parent)?;
            }
            Ok(child)
        }
        Err(error) => Err(error),
    }
}

pub fn open_dir_path(root: &Dir, relative: &Path, create: bool) -> io::Result<Dir> {
    let mut dir = root.try_clone()?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(unsafe_path());
        };
        dir = if create {
            open_or_create_child(&dir, name)?
        } else {
            dir.open_dir_nofollow(name)?
        };
    }
    Ok(dir)
}

pub fn remove_child_entry(parent: &Dir, leaf: &OsStr) -> io::Result<bool> {
    let metadata = match parent.symlink_metadata(leaf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() && !metadata.is_symlink() {
        parent.open_dir_nofollow(leaf)?.remove_open_dir_all()?;
    } else {
        parent.remove_file_or_symlink(leaf)?;
    }
    sync_dir(&parent)?;
    Ok(true)
}

pub fn read_nofollow_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    options
}

pub fn read_write_nofollow_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true).follow(FollowSymlinks::No);
    options
}

pub fn create_new_private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

pub fn create_new_content_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o666);
    }
    options
}

pub struct ScopedTempDir {
    parent: Dir,
    name: OsString,
    dir: Option<Dir>,
}

impl ScopedTempDir {
    pub fn new(parent: &Dir, prefix: &str) -> io::Result<Self> {
        for _ in 0..8 {
            let name = OsString::from(format!("{prefix}{}", Uuid::new_v4()));
            match parent.create_dir(&name) {
                Ok(()) => {
                    let dir = parent.open_dir_nofollow(&name)?;
                    sync_dir(parent)?;
                    return Ok(Self {
                        parent: parent.try_clone()?,
                        name,
                        dir: Some(dir),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failed to allocate unique temporary directory",
        ))
    }

    pub fn dir(&self) -> &Dir {
        self.dir.as_ref().expect("temporary directory is open")
    }
}

impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        if let Some(dir) = self.dir.take() {
            if dir.remove_open_dir_all().is_err() {
                let _ = self.parent.remove_dir_all(&self.name);
            }
        }
    }
}

fn unsafe_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "workspace-relative path contains an unsafe component",
    )
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use tempfile::TempDir;

    use super::{open_or_create_child, open_workspace_root, sync_dir};

    #[test]
    fn syncs_nested_directories_opened_with_nofollow_handles() {
        let workspace = TempDir::new().unwrap();
        let workspace = open_workspace_root(workspace.path()).unwrap();

        // On Linux both `workspace` and these child handles are backed by
        // O_PATH descriptors. This mirrors creation of the apply receipt
        // directory and regresses the container-only EBADF failure.
        let instafy = open_or_create_child(&workspace, OsStr::new(".instafy")).unwrap();
        let receipts = open_or_create_child(&instafy, OsStr::new("origin-apply-receipts")).unwrap();

        sync_dir(&receipts).unwrap();
    }
}
