//! The owner-only archive of files that may never reach canonical history:
//! a POSIX tar (pax headers for long names), written with mode 0600 into the
//! salvage directory (0700). Links are stored as links, never followed.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const BLOCK: usize = 512;

/// What one archive entry holds.
pub(crate) enum EntryData {
    File { bytes: Vec<u8>, executable: bool },
    Link { target: Vec<u8> },
}

/// A tar file being written.
pub(crate) struct TarWriter {
    file: File,
    path: PathBuf,
}

impl TarWriter {
    /// Create `path`, which must not exist yet, readable by its owner only.
    pub(crate) fn create(path: &Path) -> Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .with_context(|| format!("failed to create {path:?}"))?;
        Ok(Self {
            file,
            path: path.to_path_buf(),
        })
    }

    pub(crate) fn append(&mut self, name: &str, data: &EntryData) -> Result<()> {
        self.write_entry(name, data)
            .with_context(|| format!("failed to write {:?}", self.path))
    }

    fn write_entry(&mut self, name: &str, data: &EntryData) -> io::Result<()> {
        let (kind, mode, size, link) = match data {
            EntryData::File { bytes, executable } => (
                b'0',
                if *executable { 0o755 } else { 0o644 },
                bytes.len(),
                &[][..],
            ),
            EntryData::Link { target } => (b'2', 0o777, 0, target.as_slice()),
        };
        let mut records = Vec::new();
        if name.len() > 100 || !name.is_ascii() {
            records.extend(pax_record("path", name.as_bytes()));
        }
        if link.len() > 100 || !link.is_ascii() {
            records.extend(pax_record("linkpath", link));
        }
        if !records.is_empty() {
            let header = header(b"pax", b'x', 0o644, records.len(), b"");
            self.file.write_all(&header)?;
            self.write_padded(&records)?;
        }
        let short_name = truncated(name.as_bytes());
        let short_link = truncated(link);
        self.file
            .write_all(&header(short_name, kind, mode, size, short_link))?;
        if let EntryData::File { bytes, .. } = data {
            self.write_padded(bytes)?;
        }
        Ok(())
    }

    fn write_padded(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)?;
        let padding = (BLOCK - bytes.len() % BLOCK) % BLOCK;
        self.file.write_all(&vec![0u8; padding])
    }

    /// Write the end-of-archive marker and flush to disk.
    pub(crate) fn finish(mut self) -> Result<()> {
        self.file
            .write_all(&[0u8; BLOCK * 2])
            .and_then(|()| self.file.sync_all())
            .with_context(|| format!("failed to finish {:?}", self.path))
    }
}

/// The first 100 bytes, cut on a character boundary when the text is UTF-8.
fn truncated(bytes: &[u8]) -> &[u8] {
    if bytes.len() <= 100 {
        return bytes;
    }
    let mut cut = 100;
    if let Ok(text) = std::str::from_utf8(bytes) {
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
    }
    &bytes[..cut]
}

/// One pax record: `<length> <key>=<value>\n`, where the length counts the
/// whole record, its own digits included.
fn pax_record(key: &str, value: &[u8]) -> Vec<u8> {
    let rest = key.len() + value.len() + 3; // ' ', '=', '\n'
    let mut length = rest + 1;
    while length != rest + length.to_string().len() {
        length = rest + length.to_string().len();
    }
    let mut record = format!("{length} {key}=").into_bytes();
    record.extend_from_slice(value);
    record.push(b'\n');
    record
}

/// A ustar header block.
fn header(name: &[u8], kind: u8, mode: u32, size: usize, link: &[u8]) -> [u8; BLOCK] {
    let mut block = [0u8; BLOCK];
    block[..name.len()].copy_from_slice(name);
    octal(&mut block[100..108], mode as u64);
    octal(&mut block[108..116], 0);
    octal(&mut block[116..124], 0);
    octal(&mut block[124..136], size as u64);
    octal(&mut block[136..148], 0);
    block[148..156].copy_from_slice(b"        ");
    block[156] = kind;
    block[157..157 + link.len()].copy_from_slice(link);
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let checksum: u32 = block.iter().map(|byte| u32::from(*byte)).sum();
    let text = format!("{checksum:06o}\0 ");
    block[148..156].copy_from_slice(text.as_bytes());
    block
}

/// Zero-padded octal digits filling the field but its last byte (a NUL).
fn octal(field: &mut [u8], value: u64) {
    let width = field.len() - 1;
    let text = format!("{value:0width$o}");
    field[..width].copy_from_slice(&text.as_bytes()[text.len() - width..]);
    field[width] = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pax_records_count_their_own_length() {
        for value_len in [0usize, 1, 80, 89, 90, 91, 985, 986, 995, 996, 5000] {
            let record = pax_record("path", &vec![b'a'; value_len]);
            let (length, _) = std::str::from_utf8(&record)
                .unwrap()
                .split_once(' ')
                .unwrap();
            assert_eq!(
                length.parse::<usize>().unwrap(),
                record.len(),
                "{value_len}"
            );
        }
    }

    /// The system's tar reads what we write: names long and short, an
    /// executable bit, a link kept as a link, and exact contents.
    #[test]
    fn the_archive_is_a_tar_the_system_tar_reads() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar");
        let long = format!("worktree/{}/notes é.txt", "deep/".repeat(40));
        let mut writer = TarWriter::create(&archive).unwrap();
        writer
            .append(
                "worktree/.env",
                &EntryData::File {
                    bytes: b"TOKEN=x\n".to_vec(),
                    executable: false,
                },
            )
            .unwrap();
        writer
            .append(
                &long,
                &EntryData::File {
                    bytes: vec![b'z'; 1300],
                    executable: true,
                },
            )
            .unwrap();
        writer
            .append(
                "worktree/link",
                &EntryData::Link {
                    target: format!("{}y", "x/".repeat(60)).into_bytes(),
                },
            )
            .unwrap();
        writer.finish().unwrap();
        // Created once only.
        assert!(TarWriter::create(&archive).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&archive).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let status = std::process::Command::new("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read(out.join("worktree/.env")).unwrap(),
            b"TOKEN=x\n"
        );
        let extracted = out.join(&long);
        assert_eq!(std::fs::read(&extracted).unwrap(), vec![b'z'; 1300]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&extracted).unwrap().permissions().mode();
            assert_eq!(mode & 0o100, 0o100);
        }
        let link = std::fs::read_link(out.join("worktree/link")).unwrap();
        assert_eq!(
            link.to_string_lossy(),
            format!("{}y", "x/".repeat(60)).as_str()
        );
    }
}
