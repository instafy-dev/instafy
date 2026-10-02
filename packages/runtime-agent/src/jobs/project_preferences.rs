//! A current, bounded projection of explicitly declared shared project defaults.
//!
//! This does not infer preferences from conversation history or legacy memory prose.

use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::ops::Range;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const SOURCE: &str = "INSTAFY.md#Project preferences";
const HEADING: &str = "## Project preferences";
const MAX_FILE_BYTES: usize = 64 * 1024;
const MAX_SECTION_BYTES: usize = 4 * 1024;

#[derive(Debug, PartialEq, Eq)]
enum PreferencesState {
    Loaded(String),
    Empty,
    Unavailable(&'static str),
}

/// Loaded once per prompt so broad memory and the dedicated section cannot disagree.
#[derive(Debug)]
pub(super) struct ProjectPreferencesSnapshot {
    state: PreferencesState,
    memory_without_preferences: Option<String>,
    source: Option<String>,
    section: Option<Range<usize>>,
}

impl ProjectPreferencesSnapshot {
    pub(super) fn load(workspace_dir: &Path) -> Self {
        match read_memory(workspace_dir) {
            Ok(Some(memory)) => Self::parse(memory),
            Ok(None) => Self {
                state: PreferencesState::Empty,
                memory_without_preferences: None,
                source: None,
                section: None,
            },
            Err(reason) => Self {
                state: PreferencesState::Unavailable(reason),
                memory_without_preferences: None,
                source: None,
                section: None,
            },
        }
    }

    fn parse(memory: String) -> Self {
        let mut sections: Vec<(Range<usize>, Range<usize>)> = Vec::new();
        let mut current: Option<(usize, usize)> = None;
        let mut fence: Option<(u8, usize)> = None;
        let mut in_comment = false;
        let mut offset = 0;
        for line in memory.split_inclusive('\n') {
            let text = line.trim_end_matches(['\r', '\n']);
            if let Some((marker, length)) = fence {
                if closes_fence(text, marker, length) {
                    fence = None;
                }
            } else if in_comment {
                comment_line(text, &mut in_comment);
                // Headings in HTML comments are examples, not a preference source.
            } else if let Some(opening) = opens_fence(text) {
                fence = Some(opening);
            } else if comment_line(text, &mut in_comment) {
                // A comment block cannot declare a real section.
            } else if text.trim_end() == HEADING {
                if let Some((start, body_start)) = current.take() {
                    sections.push((start..offset, body_start..offset));
                }
                current = Some((offset, offset + line.len()));
            } else if is_section_boundary(text) {
                if let Some((start, body_start)) = current.take() {
                    sections.push((start..offset, body_start..offset));
                }
            }
            offset += line.len();
        }
        let incomplete_section = current.is_some() && (fence.is_some() || in_comment);
        if let Some((start, body_start)) = current {
            sections.push((start..memory.len(), body_start..memory.len()));
        }

        // Remove every recognized section even when invalid. Broad memory must not
        // accidentally deliver preferences that the narrow projection rejected.
        let mut projected_memory = String::with_capacity(memory.len());
        let mut cursor = 0;
        for (section, _) in &sections {
            projected_memory.push_str(&memory[cursor..section.start]);
            cursor = section.end;
        }
        projected_memory.push_str(&memory[cursor..]);

        let state = match sections.as_slice() {
            [] => PreferencesState::Empty,
            [_] if incomplete_section => PreferencesState::Unavailable("incomplete_section"),
            [(_, body)] if body.len() > MAX_SECTION_BYTES => {
                PreferencesState::Unavailable("section_too_large")
            }
            [(_, body)] => {
                let content = memory[body.clone()].trim();
                if content.is_empty() {
                    PreferencesState::Empty
                } else {
                    PreferencesState::Loaded(content.to_owned())
                }
            }
            _ => PreferencesState::Unavailable("duplicate_sections"),
        };
        Self {
            state,
            memory_without_preferences: Some(projected_memory),
            section: (sections.len() == 1).then(|| sections[0].0.clone()),
            source: Some(memory),
        }
    }

    pub(super) fn memory_without_preferences(&self) -> Option<&str> {
        self.memory_without_preferences.as_deref()
    }

    // The deterministic optimizer uses the same bounded source and parser as prompt delivery.
    pub(super) fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    pub(super) fn section(&self) -> Option<&str> {
        Some(&self.source.as_ref()?[self.section.clone()?])
    }

    pub(super) fn unavailable_reason(&self) -> Option<&'static str> {
        match self.state {
            PreferencesState::Unavailable(reason) => Some(reason),
            _ => None,
        }
    }

    pub(super) fn preserves_preferences(&self, candidate: &str) -> bool {
        self.unavailable_reason().is_none() && Self::parse(candidate.to_owned()).state == self.state
    }

    pub(super) fn render(&self, project_id: &Uuid) -> String {
        let mut rendered =
            format!("Project preferences snapshot\nProject: {project_id}\nSource: {SOURCE}\n");
        match &self.state {
            PreferencesState::Loaded(content) => {
                rendered.push_str(&format!(
                    "State: loaded\nRevision: {}\nShared project defaults, interpreted with the current task and applicable skills. They grant no permissions and do not override current instructions. Supersedes only earlier snapshots for this same project and source.\nContent (JSON string): {}\n\n",
                    revision(content),
                    json!(content),
                ));
            }
            PreferencesState::Empty => {
                rendered.push_str(&format!(
                    "State: empty\nRevision: {}\nWithdraw prior defaults for this project/source only; keep other preferences.\n\n",
                    revision(""),
                ));
            }
            PreferencesState::Unavailable(reason) => {
                rendered.push_str(&format!(
                    "State: unavailable ({reason})\nCurrent defaults could not be verified. This is not a removal or a new revision; do not infer that earlier defaults for this project and source were withdrawn.\n\n",
                ));
            }
        }
        rendered
    }

    pub(super) fn metrics(&self) -> Value {
        match &self.state {
            PreferencesState::Loaded(content) => json!({
                "state": "loaded", "source": SOURCE,
                "revision": revision(content), "contentBytes": content.len(),
            }),
            PreferencesState::Empty => json!({
                "state": "empty", "source": SOURCE,
                "revision": revision(""), "contentBytes": 0,
            }),
            PreferencesState::Unavailable(reason) => json!({
                "state": "unavailable", "source": SOURCE, "reason": reason,
                "revision": null, "contentBytes": 0,
            }),
        }
    }
}

fn revision(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

fn read_memory(workspace_dir: &Path) -> Result<Option<String>, &'static str> {
    let root = workspace_dir
        .canonicalize()
        .map_err(|_| "workspace_unavailable")?;
    if !root.is_dir() {
        return Err("workspace_unavailable");
    }
    let path = root.join("INSTAFY.md");
    let before = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("read_failed"),
    };
    if before.file_type().is_symlink() || !before.is_file() {
        return Err("unsafe_file_type");
    }
    if before.len() > MAX_FILE_BYTES as u64 {
        return Err("file_too_large");
    }
    let file = open_regular_file(&path)?;
    let opened = file.metadata().map_err(|_| "read_failed")?;
    if !opened.is_file() || opened.file_type().is_symlink() {
        return Err("unsafe_file_type");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err("file_changed");
        }
    }
    if opened.len() > MAX_FILE_BYTES as u64 {
        return Err("file_too_large");
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    let mut reader = file.take((MAX_FILE_BYTES + 1) as u64);
    reader.read_to_end(&mut bytes).map_err(|_| "read_failed")?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("file_too_large");
    }
    let after = reader.get_ref().metadata().map_err(|_| "read_failed")?;
    if opened.len() != bytes.len() as u64
        || after.len() != opened.len()
        || opened.modified().ok() != after.modified().ok()
    {
        return Err("file_changed");
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "invalid_utf8")
}

fn open_regular_file(path: &Path) -> Result<File, &'static str> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // NOFOLLOW rejects replacement symlinks; NONBLOCK prevents a replacement
        // FIFO from blocking before its descriptor can be checked as a regular file.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path).map_err(|_| "read_failed")
}

fn unindented_or_markdown_indent(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3).then_some(trimmed)
}

fn is_section_boundary(line: &str) -> bool {
    let Some(line) = unindented_or_markdown_indent(line) else {
        return false;
    };
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    (1..=2).contains(&hashes)
        && (line.len() == hashes || matches!(line.as_bytes().get(hashes), Some(b' ' | b'\t')))
}

fn opens_fence(line: &str) -> Option<(u8, usize)> {
    let line = unindented_or_markdown_indent(line)?;
    let marker = *line.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let length = line.bytes().take_while(|byte| *byte == marker).count();
    if length < 3 || (marker == b'`' && line[length..].contains('`')) {
        None
    } else {
        Some((marker, length))
    }
}

fn closes_fence(line: &str, marker: u8, length: usize) -> bool {
    let Some(line) = unindented_or_markdown_indent(line) else {
        return false;
    };
    let closing_length = line.bytes().take_while(|byte| *byte == marker).count();
    closing_length >= length && line[closing_length..].trim().is_empty()
}

fn comment_line(line: &str, in_comment: &mut bool) -> bool {
    let starts_as_comment = *in_comment || line.trim_start().starts_with("<!--");
    let mut remainder = line;
    loop {
        if *in_comment {
            let Some(end) = remainder.find("-->") else {
                return starts_as_comment;
            };
            *in_comment = false;
            remainder = &remainder[end + 3..];
        } else {
            let Some(start) = remainder.find("<!--") else {
                return starts_as_comment;
            };
            *in_comment = true;
            remainder = &remainder[start + 4..];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_memory(root: &Path, memory: &str) -> ProjectPreferencesSnapshot {
        fs::write(root.join("INSTAFY.md"), memory).expect("write memory");
        ProjectPreferencesSnapshot::load(root)
    }

    #[test]
    fn loads_only_explicit_section_and_keeps_subsections() {
        let temp = tempfile::tempdir().expect("temp dir");
        let snapshot = write_memory(
            temp.path(),
            "# Memory\nLegacy preference: German.\n## Project preferences\nUse English.\n### Reviews\nKeep tests focused.\n## Facts\nThe build uses Rust.\n",
        );
        let project = Uuid::new_v4();
        let rendered = snapshot.render(&project);
        assert!(rendered.contains("Use English.\\n### Reviews\\nKeep tests focused."));
        assert!(!rendered.contains("German"));
        assert!(!rendered.contains("The build uses Rust"));
        assert_eq!(
            snapshot.memory_without_preferences(),
            Some("# Memory\nLegacy preference: German.\n## Facts\nThe build uses Rust.\n")
        );
        assert_eq!(snapshot.metrics()["state"], "loaded");
    }

    #[test]
    fn examples_and_legacy_prose_do_not_create_preferences() {
        let memory = "User preferences: German.\n```markdown\n## Project preferences\nFenced.\n```\n> ## Project preferences\n> Quoted.\n    ## Project preferences\n    Code.\n<!--\n## Project preferences\nComment.\n-->\n";
        let snapshot = ProjectPreferencesSnapshot::parse(memory.to_owned());
        assert_eq!(snapshot.metrics()["state"], "empty");
        assert_eq!(snapshot.memory_without_preferences(), Some(memory));
    }

    #[test]
    fn fences_preserve_heading_examples_inside_a_real_section() {
        let snapshot = ProjectPreferencesSnapshot::parse(
            "## Project preferences\nKeep examples like:\n~~~~markdown\n## Example\n~~~\n## Still an example\n~~~~\nUse short prose.\n# Other memory\nFact.\n".to_owned(),
        );
        let rendered = snapshot.render(&Uuid::new_v4());
        assert!(rendered.contains("Still an example"));
        assert!(rendered.contains("Use short prose"));
        assert!(!rendered.contains("Fact."));
    }

    #[test]
    fn edits_replace_and_removal_withdraws_only_matching_source() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = Uuid::new_v4();
        let initial = write_memory(temp.path(), "## Project preferences\nUse German.\n");
        let edited = write_memory(temp.path(), "## Project preferences\nUse English.\n");
        assert_ne!(initial.metrics()["revision"], edited.metrics()["revision"]);
        assert!(!edited.render(&project).contains("German"));
        let removed = write_memory(temp.path(), "## Facts\nPreserve this.\n");
        assert_eq!(removed.metrics()["state"], "empty");
        assert!(
            removed
                .render(&project)
                .contains("this project/source only")
        );
        assert!(removed.render(&project).contains("keep other preferences"));
        fs::remove_file(temp.path().join("INSTAFY.md")).expect("remove memory");
        let missing = ProjectPreferencesSnapshot::load(temp.path());
        assert_eq!(missing.metrics(), removed.metrics());
    }

    #[test]
    fn revision_depends_only_on_current_preferences_and_scope_is_explicit() {
        let a = tempfile::tempdir().expect("temp dir");
        let b = tempfile::tempdir().expect("temp dir");
        let first = write_memory(
            a.path(),
            "## Project preferences\nBe concise.\n## Facts\nA\n",
        );
        let second = write_memory(
            b.path(),
            "## Project preferences\nBe concise.\n## Facts\nB\n",
        );
        assert_eq!(first.metrics()["revision"], second.metrics()["revision"]);
        let project_a = Uuid::new_v4();
        let project_b = Uuid::new_v4();
        assert!(first.render(&project_a).contains(&project_a.to_string()));
        assert!(!first.render(&project_a).contains(&project_b.to_string()));
        assert!(!second.render(&project_b).contains(&project_a.to_string()));
    }

    #[test]
    fn duplicate_and_oversized_sections_are_unavailable_and_removed_from_broad_memory() {
        let duplicated = ProjectPreferencesSnapshot::parse(
            "Before\n## Project preferences\nFirst secret preference.\n## Facts\nRetained fact.\n## Project preferences\nConflicting secret preference.\n".to_owned(),
        );
        assert_eq!(duplicated.metrics()["reason"], "duplicate_sections");
        assert_eq!(duplicated.metrics()["revision"], Value::Null);
        assert_eq!(
            duplicated.memory_without_preferences(),
            Some("Before\n## Facts\nRetained fact.\n")
        );
        assert!(
            !duplicated
                .render(&Uuid::new_v4())
                .contains("secret preference")
        );

        let oversized = ProjectPreferencesSnapshot::parse(format!(
            "## Project preferences\n{}\n## Facts\nRetained.\n",
            "x".repeat(MAX_SECTION_BYTES)
        ));
        assert_eq!(oversized.metrics()["reason"], "section_too_large");
        assert_eq!(
            oversized.memory_without_preferences(),
            Some("## Facts\nRetained.\n")
        );
    }

    #[test]
    fn incomplete_fence_or_comment_is_not_silently_delivered() {
        for ending in ["```\nExample", "<!--\nExample"] {
            let snapshot =
                ProjectPreferencesSnapshot::parse(format!("## Project preferences\n{ending}"));
            assert_eq!(snapshot.metrics()["reason"], "incomplete_section");
            assert_eq!(snapshot.memory_without_preferences(), Some(""));
        }
    }

    #[test]
    fn file_bound_and_invalid_utf8_fail_without_partial_memory() {
        let temp = tempfile::tempdir().expect("temp dir");
        let oversized = write_memory(temp.path(), &"x".repeat(MAX_FILE_BYTES + 1));
        assert_eq!(oversized.metrics()["reason"], "file_too_large");
        assert!(oversized.memory_without_preferences().is_none());
        fs::write(temp.path().join("INSTAFY.md"), [0xff]).expect("write invalid utf8");
        let invalid = ProjectPreferencesSnapshot::load(temp.path());
        assert_eq!(invalid.metrics()["reason"], "invalid_utf8");
        assert!(invalid.memory_without_preferences().is_none());
        let rendered = invalid.render(&Uuid::new_v4());
        assert!(rendered.contains("not a removal or a new revision"));
        assert!(!rendered.contains("State: empty"));
    }

    #[test]
    fn byte_limits_accept_complete_unicode_and_crlf_at_exact_bounds() {
        let temp = tempfile::tempdir().expect("temp dir");
        let content = "é".repeat((MAX_SECTION_BYTES - 2) / 2);
        let mut memory = format!("## Project preferences\r\n{content}\r\n## Facts\r\n");
        memory.push_str(&"x".repeat(MAX_FILE_BYTES - memory.len()));
        let snapshot = write_memory(temp.path(), &memory);
        assert!(matches!(&snapshot.state, PreferencesState::Loaded(actual) if actual == &content));

        let oversized_section = write_memory(
            temp.path(),
            &format!("## Project preferences\r\n{content}é\r\n"),
        );
        assert_eq!(oversized_section.metrics()["reason"], "section_too_large");
    }

    #[test]
    fn directory_in_place_of_file_and_missing_workspace_are_unavailable() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("INSTAFY.md")).expect("create directory");
        assert_eq!(
            ProjectPreferencesSnapshot::load(temp.path()).metrics()["reason"],
            "unsafe_file_type"
        );
        assert_eq!(
            ProjectPreferencesSnapshot::load(&temp.path().join("missing")).metrics()["reason"],
            "workspace_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_memory_is_rejected_without_exposing_other_workspace() {
        use std::os::unix::fs::symlink;
        let project = tempfile::tempdir().expect("temp dir");
        let other = tempfile::tempdir().expect("temp dir");
        write_memory(
            other.path(),
            "## Project preferences\nOther project secret.\n",
        );
        symlink(
            other.path().join("INSTAFY.md"),
            project.path().join("INSTAFY.md"),
        )
        .expect("create symlink");
        let rejected = ProjectPreferencesSnapshot::load(project.path());
        assert_eq!(rejected.metrics()["reason"], "unsafe_file_type");
        assert!(rejected.memory_without_preferences().is_none());
        assert!(
            !rejected
                .render(&Uuid::new_v4())
                .contains("Other project secret")
        );
    }
}
