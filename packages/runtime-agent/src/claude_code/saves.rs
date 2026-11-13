//! The lane filter of a local-engine turn's saves (docs/Local-Engine-Turns.md 3.8, step 3).
//!
//! A lane save, and a stopped lane turn's report, leave on this computer:
//! - every path with a `.claude` segment, and every `CLAUDE.local.md`: Claude Code's per-person
//!   files. A saved `.claude/settings.json` would carry hooks onto teammates' machines;
//! - the `.mcp.json` at the folder's root, which would offer teammates MCP servers to run. A saved
//!   one, like a saved `.claude/` path, would also make the pre-flight refuse every later lane
//!   turn in the space. A deeper `.mcp.json` belongs to a plugin, and saves;
//! - every file whose content holds a token: `sk-ant-`, followed by at least 20 of
//!   `[A-Za-z0-9_-]`, not preceded by a letter or digit. A bare mention of the prefix saves.
//!
//! Names compare ignoring ASCII case, as macOS folders do (`.Claude/`, `claude.local.md`). The
//! publish policy matches file names only, so without the content check a token that Claude Code
//! or a tool wrote into an ordinary file would reach every teammate's checkout. The filter applies
//! to lane saves only (D21).

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

/// The prefix of a token the content check looks for, matched ignoring ASCII case.
const TOKEN_PREFIX: &[u8] = b"sk-ant-";
/// How many token characters must follow the prefix.
const TOKEN_MIN_TAIL: usize = 20;
const TOKEN_MIN_LEN: usize = TOKEN_PREFIX.len() + TOKEN_MIN_TAIL;
const READ_CHUNK_BYTES: usize = 256 * 1024;

/// Why a lane save left a file on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptOff {
    /// One of Claude Code's own files: a `.claude` path, a `CLAUDE.local.md` or the root
    /// `.mcp.json`.
    ClaudeCodeFile,
    /// Its content holds what looks like a Claude key or token.
    HoldsAToken,
    /// Its content could not be read, so nothing can say it holds no token.
    Unchecked,
}

/// Whether a lane save leaves the folder-relative, `/`-separated `path` on this computer by its
/// name.
pub fn is_claude_code_file(path: &str) -> bool {
    let segments: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    segments
        .iter()
        .any(|segment| segment.eq_ignore_ascii_case(".claude"))
        || segments
            .last()
            .is_some_and(|name| name.eq_ignore_ascii_case("CLAUDE.local.md"))
        || matches!(segments.as_slice(), [name] if name.eq_ignore_ascii_case(".mcp.json"))
}

fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// Whether a token starts at `at` in `bytes`, which holds at least [`TOKEN_MIN_LEN`] bytes from
/// there, or the rest of the content. `before` is the byte before it, if any.
fn token_at(bytes: &[u8], at: usize, before: Option<u8>) -> bool {
    bytes.len() - at >= TOKEN_MIN_LEN
        && bytes[at..at + TOKEN_PREFIX.len()].eq_ignore_ascii_case(TOKEN_PREFIX)
        && !before.is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes[at + TOKEN_PREFIX.len()..at + TOKEN_MIN_LEN]
            .iter()
            .all(|byte| is_token_char(*byte))
}

/// Whether `bytes` hold a token (see the module's description).
pub fn holds_claude_token(bytes: &[u8]) -> bool {
    (0..bytes.len()).any(|at| token_at(bytes, at, at.checked_sub(1).map(|before| bytes[before])))
}

/// Whether the content of `reader` holds a token, read in chunks of any size.
pub fn reader_holds_claude_token(mut reader: impl Read) -> io::Result<bool> {
    let mut window: Vec<u8> = Vec::new();
    // The byte before `window[0]`, once the window no longer starts at the content's start.
    let mut before: Option<u8> = None;
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let ended = read == 0;
        window.extend_from_slice(&chunk[..read]);
        // A start with fewer than TOKEN_MIN_LEN bytes after it is decided once more arrive.
        let decided = if ended {
            window.len()
        } else {
            window.len().saturating_sub(TOKEN_MIN_LEN - 1)
        };
        for at in 0..decided {
            let previous = if at == 0 {
                before
            } else {
                Some(window[at - 1])
            };
            if token_at(&window, at, previous) {
                return Ok(true);
            }
        }
        if ended {
            return Ok(false);
        }
        if decided > 0 {
            before = Some(window[decided - 1]);
            window.drain(..decided);
        }
    }
}

/// Whether the file at `path` holds a token. A regular file is read whole; a symbolic link is
/// saved as the path it holds, so that path is what is read; anything else holds no content git
/// saves.
pub fn file_holds_claude_token(path: &Path) -> io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path)?;
        return Ok(holds_claude_token(target.as_os_str().as_encoded_bytes()));
    }
    if !metadata.is_file() {
        return Ok(false);
    }
    reader_holds_claude_token(open_without_following(path)?)
}

#[cfg(unix)]
fn open_without_following(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_without_following(path: &Path) -> io::Result<File> {
    File::open(path)
}

/// Why a lane save leaves the folder-relative `path` in `folder` on this computer, if it does. A
/// file whose content cannot be read is left there too: nothing can say it holds no token.
pub fn kept_off(folder: &Path, path: &str) -> Option<KeptOff> {
    if is_claude_code_file(path) {
        return Some(KeptOff::ClaudeCodeFile);
    }
    match file_holds_claude_token(&folder.join(path)) {
        Ok(false) => None,
        // A file the turn deleted holds nothing, and its deletion saves.
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Ok(true) => Some(KeptOff::HoldsAToken),
        Err(_) => Some(KeptOff::Unchecked),
    }
}

/// [`kept_off`] for each of `paths`, in order, read off the async workers: a file's content is
/// read whole.
pub async fn kept_off_all(folder: &Path, paths: Vec<String>) -> Vec<Option<KeptOff>> {
    let folder = folder.to_path_buf();
    let count = paths.len();
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| kept_off(&folder, path))
            .collect::<Vec<_>>()
    })
    .await
    // A read that could not finish checked nothing: every file stays on this computer.
    .unwrap_or_else(|_| vec![Some(KeptOff::Unchecked); count])
}

/// The sentence of the status step that names each file a lane save left on this computer, or
/// `None` when it left none (3.8, step 6).
pub fn kept_off_sentence(kept: &[(String, KeptOff)]) -> Option<String> {
    let names = |reason: KeptOff| -> Vec<&str> {
        kept.iter()
            .filter(|(_, why)| *why == reason)
            .map(|(path, _)| path.as_str())
            .collect()
    };
    let own = names(KeptOff::ClaudeCodeFile);
    let tokens = names(KeptOff::HoldsAToken);
    let unchecked = names(KeptOff::Unchecked);
    let mut sentences = Vec::new();
    if !own.is_empty() {
        sentences.push(format!(
            "Not saved: {} (Claude Code's own files stay on this computer)",
            own.join(", ")
        ));
    }
    if !tokens.is_empty() {
        sentences.push(format!(
            "Not saved: {} (it looks like a Claude key is in {}, so {} stays on this computer)",
            tokens.join(", "),
            if tokens.len() == 1 { "it" } else { "them" },
            if tokens.len() == 1 { "it" } else { "each" },
        ));
    }
    if !unchecked.is_empty() {
        sentences.push(format!(
            "Not saved: {} (Instafy couldn't check {} for a Claude key)",
            unchecked.join(", "),
            if unchecked.len() == 1 { "it" } else { "them" },
        ));
    }
    (!sentences.is_empty()).then(|| sentences.join(". ") + ".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_codes_own_files_are_named_ignoring_case_and_a_deeper_mcp_json_saves() {
        for kept in [
            ".claude/settings.json",
            ".Claude/settings.local.json",
            "app/.CLAUDE/agents/x.md",
            ".claude",
            "CLAUDE.local.md",
            "claude.local.md",
            "docs/Claude.Local.MD",
            ".mcp.json",
            ".MCP.json",
            "./.mcp.json",
        ] {
            assert!(is_claude_code_file(kept), "{kept}");
        }
        for saved in [
            "CLAUDE.md",
            "AGENTS.md",
            "claude-plugin/instafy/.mcp.json",
            "docs/.mcp.json",
            ".claudex/settings.json",
            "x.claude",
            "notes/claude.md",
            "README.md",
        ] {
            assert!(!is_claude_code_file(saved), "{saved}");
        }
    }

    #[test]
    fn a_token_needs_twenty_token_characters_and_no_letter_or_digit_before_it() {
        let token = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for holds in [
            token.to_string(),
            format!("ANTHROPIC_API_KEY={token}"),
            format!("key: \"{}\"", token.to_uppercase()),
            format!("{}\n", "Sk-Ant-api03-aaaaaaaaaaaaaaaaaaaa"),
            format!("x {token} y"),
            format!("_{token}"),
        ] {
            assert!(holds_claude_token(holds.as_bytes()), "{holds}");
            assert!(
                reader_holds_claude_token(holds.as_bytes()).unwrap(),
                "{holds}"
            );
        }
        for clean in [
            "keys start with sk-ant- and are secret",
            "sk-ant-",
            "sk-ant-short_19chars_xx",
            "risk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "9sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "sk-ant-ABCDEFGHIJ KLMNOPQRSTUVWXYZ",
            "sk_ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "",
        ] {
            assert!(!holds_claude_token(clean.as_bytes()), "{clean}");
            assert!(
                !reader_holds_claude_token(clean.as_bytes()).unwrap(),
                "{clean}"
            );
        }
        // Exactly twenty characters after the prefix is a token.
        assert!(holds_claude_token(b"sk-ant-12345678901234567890"));
        assert!(!holds_claude_token(b"sk-ant-1234567890123456789"));
    }

    /// A reader that hands out its bytes a few at a time, so tokens cross chunk boundaries.
    struct Trickle<'a> {
        bytes: &'a [u8],
        step: usize,
    }

    impl Read for Trickle<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let take = self.step.min(self.bytes.len()).min(buffer.len());
            buffer[..take].copy_from_slice(&self.bytes[..take]);
            self.bytes = &self.bytes[take..];
            Ok(take)
        }
    }

    #[test]
    fn a_token_is_found_across_reads_of_any_size_and_its_neighbour_is_kept() {
        let mut text = "a".repeat(1_000).into_bytes();
        text.extend_from_slice(b" sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ tail");
        let mut letter_before = "a".repeat(1_000).into_bytes();
        letter_before.extend_from_slice(b"Xsk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ tail");
        let mut digit_before_at_a_boundary = "a".repeat(999).into_bytes();
        digit_before_at_a_boundary.extend_from_slice(b"7sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
        for step in [1, 2, 3, 7, 26, 27, 28, 64, 999, 1_000, 1_001, 4_096] {
            assert!(
                reader_holds_claude_token(Trickle { bytes: &text, step }).unwrap(),
                "{step}"
            );
            for clean in [&letter_before, &digit_before_at_a_boundary] {
                assert!(
                    !reader_holds_claude_token(Trickle { bytes: clean, step }).unwrap(),
                    "{step}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn files_links_and_deletions_are_read_as_git_saves_them() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path();
        std::fs::create_dir_all(folder.join("docs")).unwrap();
        std::fs::write(
            folder.join("docs/setup.md"),
            "Export sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ first.\n",
        )
        .unwrap();
        std::fs::write(folder.join("docs/keys.md"), "Keys start with sk-ant-.\n").unwrap();
        std::os::unix::fs::symlink(
            "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            folder.join("token-link"),
        )
        .unwrap();
        std::os::unix::fs::symlink("docs/setup.md", folder.join("plain-link")).unwrap();
        assert_eq!(
            kept_off(folder, "docs/setup.md"),
            Some(KeptOff::HoldsAToken)
        );
        assert_eq!(kept_off(folder, "docs/keys.md"), None);
        assert_eq!(kept_off(folder, "token-link"), Some(KeptOff::HoldsAToken));
        // A link is saved as the path it holds, not as what it points at.
        assert_eq!(kept_off(folder, "plain-link"), None);
        assert_eq!(kept_off(folder, "deleted.md"), None);
        assert_eq!(
            kept_off(folder, ".claude/settings.json"),
            Some(KeptOff::ClaudeCodeFile)
        );
        assert_eq!(kept_off(folder, "docs"), None);
    }

    #[test]
    fn the_status_step_names_each_file_it_left_on_this_computer() {
        assert_eq!(kept_off_sentence(&[]), None);
        let sentence = kept_off_sentence(&[
            (".claude/settings.json".into(), KeptOff::ClaudeCodeFile),
            ("CLAUDE.local.md".into(), KeptOff::ClaudeCodeFile),
            ("notes.txt".into(), KeptOff::HoldsAToken),
        ])
        .unwrap();
        assert_eq!(
            sentence,
            "Not saved: .claude/settings.json, CLAUDE.local.md (Claude Code's own files stay on this computer). Not saved: notes.txt (it looks like a Claude key is in it, so it stays on this computer)."
        );
    }
}
