//! Descriptor-relative workspace filesystem access.
//!
//! User-controlled workspace paths must never be resolved with `root.join(path)`:
//! an otherwise lexical-safe path can contain a symlinked ancestor and escape the
//! workspace. On Unix this module pins the workspace root as a directory
//! descriptor and opens every descendant component with `O_NOFOLLOW`. On
//! Windows it uses capability directory handles and no-follow opens for every
//! component. The deliberately strict contract rejects all symlink traversal,
//! including links whose current target happens to remain inside the workspace.

use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use std::path::PathBuf;
use std::path::{Component, Path};
use std::sync::Arc;

#[cfg(windows)]
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(windows)]
use cap_std::fs::{Dir as CapabilityDir, OpenOptions};
#[cfg(unix)]
use rustix::fd::OwnedFd;
#[cfg(unix)]
use rustix::fs::{self, AtFlags, Dir, FileType, Mode, OFlags};
use uuid::Uuid;

#[cfg(unix)]
const DIRECTORY_OPEN_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
#[cfg(unix)]
const FILE_OPEN_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

#[derive(Debug)]
pub struct WorkspaceListEntry {
    pub name: OsString,
    pub kind: WorkspaceEntryKind,
    pub metadata: Option<Metadata>,
    pub has_children: bool,
}

#[derive(Clone, Debug)]
pub struct WorkspaceDir {
    #[cfg(unix)]
    fd: Arc<OwnedFd>,
    #[cfg(windows)]
    dir: Arc<CapabilityDir>,
    // `Command::current_dir` has no handle-relative Windows equivalent. Keep
    // this only for spawning local git; HTTP/apply filesystem access always
    // uses `dir`. Team sharing remains disabled because an unrestricted local
    // process could race ambient paths or access files outside this facade.
    #[cfg(windows)]
    ambient_path: Arc<PathBuf>,
}

#[cfg(unix)]
impl WorkspaceDir {
    /// Open a trusted, already-created root. The final root component itself
    /// must be a real directory rather than a symlink.
    pub fn open(root: &Path) -> io::Result<Self> {
        let fd = fs::open(root, DIRECTORY_OPEN_FLAGS, Mode::empty()).map_err(to_io_error)?;
        Ok(Self { fd: Arc::new(fd) })
    }

    /// Open a descendant directory without following any path component.
    pub fn open_dir(&self, relative: &str) -> io::Result<Self> {
        let components = validated_components(relative, true)?;
        let fd = self.walk_directories(&components, false)?;
        Ok(Self { fd: Arc::new(fd) })
    }

    /// Create and open a descendant directory without following any path
    /// component. Existing symlinks are rejected rather than traversed.
    pub fn create_dir_all(&self, relative: &str) -> io::Result<Self> {
        let components = validated_components(relative, true)?;
        let fd = self.walk_directories(&components, true)?;
        Ok(Self { fd: Arc::new(fd) })
    }

    pub fn entry_kind(&self, relative: &str) -> io::Result<WorkspaceEntryKind> {
        if relative.trim().is_empty() {
            return Ok(WorkspaceEntryKind::Directory);
        }
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, false)?;
        let stat = fs::statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW).map_err(to_io_error)?;
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::RegularFile => Ok(WorkspaceEntryKind::File),
            FileType::Directory => Ok(WorkspaceEntryKind::Directory),
            FileType::Symlink => Err(symlink_rejected()),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspace entry is not a regular file or directory",
            )),
        }
    }

    pub fn open_file(&self, relative: &str) -> io::Result<File> {
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, false)?;
        let fd = fs::openat(&parent, &leaf, FILE_OPEN_FLAGS, Mode::empty()).map_err(to_io_error)?;
        let file = File::from(fd);
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspace entry is not a regular file",
            ));
        }
        Ok(file)
    }

    /// List regular files and real directories. Symlinks and special files are
    /// intentionally omitted so callers cannot accidentally turn metadata or
    /// `hasChildren` probes into a traversal primitive.
    pub fn list(&self, relative: Option<&str>) -> io::Result<Vec<WorkspaceListEntry>> {
        let directory = match relative.filter(|value| !value.trim().is_empty()) {
            Some(relative) => self.open_dir(relative)?,
            None => self.clone(),
        };
        directory.list_current()
    }

    /// Atomically replace a workspace file. The payload is copied into a
    /// fresh temporary leaf in the already-open destination parent and then
    /// renamed, so neither an ancestor nor an existing final symlink is ever
    /// followed.
    pub fn replace_file<R: Read>(
        &self,
        relative: &str,
        reader: &mut R,
        executable: bool,
    ) -> io::Result<u64> {
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, true)?;
        let temp_name = OsString::from(format!(".instafy-write-{}", Uuid::new_v4()));
        let mode = Mode::from_raw_mode(if executable { 0o755 } else { 0o644 });
        let temp_fd = fs::openat(
            &parent,
            &temp_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            mode,
        )
        .map_err(to_io_error)?;

        let result = (|| {
            let mut temp_file = File::from(temp_fd);
            let copied = io::copy(reader, &mut temp_file)?;
            temp_file.flush()?;
            temp_file.sync_all()?;
            fs::fchmod(&temp_file, mode).map_err(to_io_error)?;
            drop(temp_file);
            fs::renameat(&parent, &temp_name, &parent, &leaf).map_err(to_io_error)?;
            // Directory fsync is supported on Linux and macOS. A durability
            // failure should be reported even though containment is intact.
            fs::fsync(&parent).map_err(to_io_error)?;
            Ok(copied)
        })();

        if result.is_err() {
            let _ = fs::unlinkat(&parent, &temp_name, AtFlags::empty());
        }
        result
    }

    /// Remove one file, symlink, or directory tree without following any
    /// symlink encountered in the tree.
    pub fn remove(&self, relative: &str) -> io::Result<()> {
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, false)?;
        remove_entry(&parent, &leaf)
    }

    /// Rename two entries inside this same workspace. Ancestor traversal is
    /// descriptor-relative; final symlinks, if present, are moved as links and
    /// never dereferenced.
    pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        let from_components = validated_components(from, false)?;
        let to_components = validated_components(to, false)?;
        let (from_parent, from_leaf) = self.open_parent(&from_components, false)?;
        let (to_parent, to_leaf) = self.open_parent(&to_components, true)?;
        fs::renameat(&from_parent, &from_leaf, &to_parent, &to_leaf).map_err(to_io_error)
    }

    pub(crate) fn duplicate_fd(&self) -> io::Result<OwnedFd> {
        rustix::io::dup(self.fd.as_ref()).map_err(to_io_error)
    }

    fn walk_directories(&self, components: &[OsString], create: bool) -> io::Result<OwnedFd> {
        let mut current = rustix::io::dup(self.fd.as_ref()).map_err(to_io_error)?;
        for component in components {
            match fs::openat(&current, component, DIRECTORY_OPEN_FLAGS, Mode::empty()) {
                Ok(next) => current = next,
                Err(error) if create && error == rustix::io::Errno::NOENT => {
                    match fs::mkdirat(&current, component, Mode::from_raw_mode(0o755)) {
                        Ok(()) => {}
                        Err(error) if error == rustix::io::Errno::EXIST => {}
                        Err(error) => return Err(to_io_error(error)),
                    }
                    current = fs::openat(&current, component, DIRECTORY_OPEN_FLAGS, Mode::empty())
                        .map_err(to_io_error)?;
                }
                Err(error) => return Err(to_io_error(error)),
            }
        }
        Ok(current)
    }

    fn open_parent(
        &self,
        components: &[OsString],
        create: bool,
    ) -> io::Result<(OwnedFd, OsString)> {
        let (leaf, parents) = components
            .split_last()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path is empty"))?;
        let parent = self.walk_directories(parents, create)?;
        Ok((parent, leaf.clone()))
    }

    fn list_current(&self) -> io::Result<Vec<WorkspaceListEntry>> {
        let mut output = Vec::new();
        let mut directory = Dir::read_from(self.fd.as_ref()).map_err(to_io_error)?;
        for entry in &mut directory {
            let entry = entry.map_err(to_io_error)?;
            let bytes = entry.file_name().to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = OsString::from_vec(bytes.to_vec());
            let stat = match fs::statat(self.fd.as_ref(), &name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                Err(error) if error == rustix::io::Errno::NOENT => continue,
                Err(error) => return Err(to_io_error(error)),
            };
            match FileType::from_raw_mode(stat.st_mode) {
                FileType::RegularFile => {
                    let fd =
                        match fs::openat(self.fd.as_ref(), &name, FILE_OPEN_FLAGS, Mode::empty()) {
                            Ok(fd) => fd,
                            Err(error)
                                if error == rustix::io::Errno::NOENT
                                    || error == rustix::io::Errno::LOOP =>
                            {
                                continue;
                            }
                            Err(error) => return Err(to_io_error(error)),
                        };
                    let file = File::from(fd);
                    let metadata = file.metadata()?;
                    if metadata.is_file() {
                        output.push(WorkspaceListEntry {
                            name,
                            kind: WorkspaceEntryKind::File,
                            metadata: Some(metadata),
                            has_children: false,
                        });
                    }
                }
                FileType::Directory => {
                    let fd = match fs::openat(
                        self.fd.as_ref(),
                        &name,
                        DIRECTORY_OPEN_FLAGS,
                        Mode::empty(),
                    ) {
                        Ok(fd) => fd,
                        Err(error)
                            if error == rustix::io::Errno::NOENT
                                || error == rustix::io::Errno::LOOP
                                || error == rustix::io::Errno::NOTDIR =>
                        {
                            continue;
                        }
                        Err(error) => return Err(to_io_error(error)),
                    };
                    let child = Self { fd: Arc::new(fd) };
                    output.push(WorkspaceListEntry {
                        name,
                        kind: WorkspaceEntryKind::Directory,
                        metadata: None,
                        has_children: child.has_visible_children()?,
                    });
                }
                // Never expose or traverse symlinks, devices, sockets, or FIFOs.
                _ => {}
            }
        }
        Ok(output)
    }

    fn has_visible_children(&self) -> io::Result<bool> {
        let mut directory = Dir::read_from(self.fd.as_ref()).map_err(to_io_error)?;
        for entry in &mut directory {
            let entry = entry.map_err(to_io_error)?;
            let bytes = entry.file_name().to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let stat = match fs::statat(
                self.fd.as_ref(),
                entry.file_name(),
                AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Ok(stat) => stat,
                Err(error) if error == rustix::io::Errno::NOENT => continue,
                Err(error) => return Err(to_io_error(error)),
            };
            if matches!(
                FileType::from_raw_mode(stat.st_mode),
                FileType::RegularFile | FileType::Directory
            ) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(windows)]
impl WorkspaceDir {
    /// Open a trusted, already-created root as a Windows capability directory.
    /// All user-controlled descendants are subsequently resolved one component
    /// at a time with no-follow semantics.
    pub fn open(root: &Path) -> io::Result<Self> {
        let metadata = std::fs::symlink_metadata(root)?;
        if metadata.file_type().is_symlink() {
            return Err(symlink_rejected());
        }
        if !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace root is not a directory",
            ));
        }
        let dir = CapabilityDir::open_ambient_dir(root, cap_fs_ext::ambient_authority())?;
        Ok(Self {
            dir: Arc::new(dir),
            ambient_path: Arc::new(root.to_path_buf()),
        })
    }

    pub fn open_dir(&self, relative: &str) -> io::Result<Self> {
        let components = validated_components(relative, true)?;
        self.walk_directories(&components, false)
    }

    pub fn create_dir_all(&self, relative: &str) -> io::Result<Self> {
        let components = validated_components(relative, true)?;
        self.walk_directories(&components, true)
    }

    pub fn entry_kind(&self, relative: &str) -> io::Result<WorkspaceEntryKind> {
        if relative.trim().is_empty() {
            return Ok(WorkspaceEntryKind::Directory);
        }
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, false)?;
        let metadata = parent.dir.symlink_metadata(&leaf)?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(symlink_rejected());
        }
        if metadata.is_file() {
            return Ok(WorkspaceEntryKind::File);
        }
        if metadata.is_dir() {
            return Ok(WorkspaceEntryKind::Directory);
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace entry is not a regular file or directory",
        ))
    }

    pub fn open_file(&self, relative: &str) -> io::Result<File> {
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, false)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = parent.dir.open_with(&leaf, &options)?.into_std();
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspace entry is not a regular file",
            ));
        }
        Ok(file)
    }

    pub fn list(&self, relative: Option<&str>) -> io::Result<Vec<WorkspaceListEntry>> {
        let directory = match relative.filter(|value| !value.trim().is_empty()) {
            Some(relative) => self.open_dir(relative)?,
            None => self.clone(),
        };
        directory.list_current()
    }

    pub fn replace_file<R: Read>(
        &self,
        relative: &str,
        reader: &mut R,
        _executable: bool,
    ) -> io::Result<u64> {
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, true)?;
        let temp_name = OsString::from(format!(".instafy-write-{}", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut temp_file = parent.dir.open_with(&temp_name, &options)?;

        let result = (|| {
            let copied = io::copy(reader, &mut temp_file)?;
            temp_file.flush()?;
            temp_file.sync_all()?;
            drop(temp_file);
            // `Dir::rename` has `std::fs::rename` replacement semantics. On
            // Windows that uses `MOVEFILE_REPLACE_EXISTING` (with the modern
            // handle-based fallback), so updates keep replacing an existing
            // file atomically instead of degrading to remove-then-rename.
            parent.dir.rename(&temp_name, &parent.dir, &leaf)?;
            Ok(copied)
        })();

        if result.is_err() {
            let _ = parent.dir.remove_file_or_symlink(&temp_name);
        }
        result
    }

    pub fn remove(&self, relative: &str) -> io::Result<()> {
        let components = validated_components(relative, false)?;
        let (parent, leaf) = self.open_parent(&components, false)?;
        remove_entry_windows(&parent.dir, &leaf)
    }

    pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        let from_components = validated_components(from, false)?;
        let to_components = validated_components(to, false)?;
        let (from_parent, from_leaf) = self.open_parent(&from_components, false)?;
        let (to_parent, to_leaf) = self.open_parent(&to_components, true)?;
        from_parent.dir.rename(&from_leaf, &to_parent.dir, &to_leaf)
    }

    pub(crate) fn ambient_path(&self) -> &Path {
        self.ambient_path.as_path()
    }

    fn walk_directories(&self, components: &[OsString], create: bool) -> io::Result<Self> {
        let mut current = self.dir.try_clone()?;
        let mut ambient_path = self.ambient_path.as_ref().clone();
        for component in components {
            match current.open_dir_nofollow(component) {
                Ok(next) => current = next,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    match current.create_dir(component) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error),
                    }
                    current = current.open_dir_nofollow(component)?;
                }
                Err(error) => return Err(error),
            }
            ambient_path.push(component);
        }
        Ok(Self {
            dir: Arc::new(current),
            ambient_path: Arc::new(ambient_path),
        })
    }

    fn open_parent(&self, components: &[OsString], create: bool) -> io::Result<(Self, OsString)> {
        let (leaf, parents) = components
            .split_last()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path is empty"))?;
        let parent = self.walk_directories(parents, create)?;
        Ok((parent, leaf.clone()))
    }

    fn list_current(&self) -> io::Result<Vec<WorkspaceListEntry>> {
        let mut output = Vec::new();
        for entry in self.dir.entries()? {
            let entry = entry?;
            let name = entry.file_name();
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_file() {
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                let file = self.dir.open_with(&name, &options)?.into_std();
                let metadata = file.metadata()?;
                if metadata.is_file() {
                    output.push(WorkspaceListEntry {
                        name,
                        kind: WorkspaceEntryKind::File,
                        metadata: Some(metadata),
                        has_children: false,
                    });
                }
            } else if file_type.is_dir() {
                let child = self.dir.open_dir_nofollow(&name)?;
                output.push(WorkspaceListEntry {
                    name,
                    kind: WorkspaceEntryKind::Directory,
                    metadata: None,
                    has_children: has_visible_children_windows(&child)?,
                });
            }
        }
        Ok(output)
    }
}

#[cfg(unix)]
fn remove_entry(parent: &OwnedFd, leaf: &OsStr) -> io::Result<()> {
    let stat = fs::statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW).map_err(to_io_error)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
        return fs::unlinkat(parent, leaf, AtFlags::empty()).map_err(to_io_error);
    }

    let child =
        fs::openat(parent, leaf, DIRECTORY_OPEN_FLAGS, Mode::empty()).map_err(to_io_error)?;
    let mut entries = Dir::read_from(&child).map_err(to_io_error)?;
    for entry in &mut entries {
        let entry = entry.map_err(to_io_error)?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        remove_entry(&child, OsStr::from_bytes(bytes))?;
    }
    drop(entries);
    fs::unlinkat(parent, leaf, AtFlags::REMOVEDIR).map_err(to_io_error)
}

#[cfg(windows)]
fn remove_entry_windows(parent: &CapabilityDir, leaf: &OsStr) -> io::Result<()> {
    let metadata = parent.symlink_metadata(leaf)?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() || !metadata.is_dir() {
        return parent.remove_file_or_symlink(leaf);
    }

    let child = parent.open_dir_nofollow(leaf)?;
    let names = child
        .entries()?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<Vec<_>>>()?;
    for name in names {
        remove_entry_windows(&child, &name)?;
    }
    parent.remove_dir(leaf)
}

#[cfg(windows)]
fn has_visible_children_windows(directory: &CapabilityDir) -> io::Result<bool> {
    for entry in directory.entries()? {
        let file_type = entry?.file_type()?;
        if !file_type.is_symlink() && (file_type.is_file() || file_type.is_dir()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validated_components(path: &str, allow_empty: bool) -> io::Result<Vec<OsString>> {
    if path.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    let mut components = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(component) => components.push(component.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path must remain relative to the workspace",
                ));
            }
        }
    }
    if components.is_empty() && !allow_empty {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path is empty"));
    }
    Ok(components)
}

fn symlink_rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "workspace symlink traversal is not allowed",
    )
}

#[cfg(unix)]
fn to_io_error(error: rustix::io::Errno) -> io::Error {
    io::Error::from_raw_os_error(error.raw_os_error())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;

    use super::{WorkspaceDir, WorkspaceEntryKind};

    #[cfg(unix)]
    #[test]
    fn rejects_final_and_ancestor_symlinks_for_reads_and_lists() {
        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        fs::write(outside.path().join("secret.txt"), b"outside").expect("outside secret");
        symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("file-link"),
        )
        .expect("file symlink");
        symlink(outside.path(), workspace.path().join("dir-link")).expect("dir symlink");

        let root = WorkspaceDir::open(workspace.path()).expect("open workspace");
        assert!(root.open_file("file-link").is_err());
        assert!(root.open_file("dir-link/secret.txt").is_err());
        assert!(root.list(Some("dir-link")).is_err());
        let names = root
            .list(None)
            .expect("list root")
            .into_iter()
            .map(|entry| entry.name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!names.contains(&"file-link".to_string()));
        assert!(!names.contains(&"dir-link".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_does_not_follow_final_or_parent_symlinks() {
        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, b"outside").expect("outside secret");
        symlink(&outside_file, workspace.path().join("replace-me")).expect("final symlink");
        symlink(outside.path(), workspace.path().join("dir-link")).expect("dir symlink");

        let root = WorkspaceDir::open(workspace.path()).expect("open workspace");
        let mut replacement = Cursor::new(b"inside".to_vec());
        root.replace_file("replace-me", &mut replacement, false)
            .expect("replace link itself");
        assert_eq!(
            fs::read(workspace.path().join("replace-me")).unwrap(),
            b"inside"
        );
        assert_eq!(fs::read(&outside_file).unwrap(), b"outside");

        let mut blocked = Cursor::new(b"blocked".to_vec());
        assert!(root
            .replace_file("dir-link/secret.txt", &mut blocked, false)
            .is_err());
        assert_eq!(fs::read(&outside_file).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_unlinks_links_without_touching_targets() {
        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, b"outside").expect("outside secret");
        fs::create_dir_all(workspace.path().join("tree/nested")).expect("tree");
        fs::write(workspace.path().join("tree/nested/inside.txt"), b"inside").expect("inside file");
        symlink(outside.path(), workspace.path().join("tree/outbound")).expect("tree symlink");
        symlink(outside.path(), workspace.path().join("parent-link")).expect("parent symlink");

        let root = WorkspaceDir::open(workspace.path()).expect("open workspace");
        assert!(root.remove("parent-link/secret.txt").is_err());
        root.remove("tree").expect("remove safe tree");
        assert!(!workspace.path().join("tree").exists());
        assert_eq!(fs::read(&outside_file).unwrap(), b"outside");
    }

    #[test]
    fn creates_real_directories_and_reports_regular_kinds() {
        let workspace = TempDir::new().expect("workspace");
        let root = WorkspaceDir::open(workspace.path()).expect("open workspace");
        root.create_dir_all("a/b").expect("create directories");
        let mut contents = Cursor::new(b"hello".to_vec());
        root.replace_file("a/b/file.txt", &mut contents, false)
            .expect("write file");
        assert_eq!(
            root.entry_kind("a/b").expect("directory kind"),
            WorkspaceEntryKind::Directory
        );
        assert_eq!(
            root.entry_kind("a/b/file.txt").expect("file kind"),
            WorkspaceEntryKind::File
        );
    }

    #[test]
    fn atomic_replace_overwrites_an_existing_regular_file() {
        let workspace = TempDir::new().expect("workspace");
        let root = WorkspaceDir::open(workspace.path()).expect("open workspace");
        let mut first = Cursor::new(b"first".to_vec());
        root.replace_file("file.txt", &mut first, false)
            .expect("first write");
        let mut second = Cursor::new(b"second".to_vec());
        root.replace_file("file.txt", &mut second, false)
            .expect("replacement write");
        assert_eq!(
            fs::read(workspace.path().join("file.txt")).unwrap(),
            b"second"
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_junction_ancestors() {
        use std::process::Command;

        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        fs::write(outside.path().join("secret.txt"), b"outside").expect("outside secret");
        let junction = workspace.path().join("junction");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .status()
            .expect("launch mklink");
        assert!(status.success(), "mklink /J failed with {status}");

        let root = WorkspaceDir::open(workspace.path()).expect("open workspace");
        assert!(root.open_dir("junction").is_err());
        assert!(root.open_file("junction/secret.txt").is_err());
        let names = root
            .list(None)
            .expect("list root")
            .into_iter()
            .map(|entry| entry.name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!names.contains(&"junction".to_string()));
    }
}
