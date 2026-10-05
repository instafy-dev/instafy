//! `.salvage/report.jsonl`: one line per entry and run with `--apply`, and
//! what later runs read back from it.

use std::collections::BTreeMap;
use std::io::{BufRead as _, Write as _};
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Deserialize;

use super::options::Settings;

const JOURNAL: &str = "report.jsonl";

/// The journal, opened for appending (created 0600).
pub(super) fn open(settings: &Settings) -> Result<(std::fs::File, PathBuf)> {
    let path = settings.salvage_dir().join(JOURNAL);
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .with_context(|| format!("failed to open {path:?}"))?;
    Ok((file, path))
}

/// Append one line and wait until it is on disk.
pub(super) fn append(settings: &Settings, line: &str) -> Result<()> {
    let (mut file, path) = open(settings)?;
    writeln!(file, "{line}")
        .and_then(|()| file.sync_all())
        .with_context(|| format!("failed to append to {path:?}"))
}

/// A salvage ref an earlier run verified on canonical for an entry, and
/// what the entry held then.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Recorded {
    pub head: Option<String>,
    pub source_tree: Option<String>,
    pub salvage_ref: Option<String>,
    pub salvage_rev: Option<String>,
    pub history_filtered: bool,
    pub skipped_paths: Vec<RecordedSkip>,
}

/// A path an earlier run left out.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub(crate) struct RecordedSkip {
    pub path: String,
    pub size: u64,
    pub reason: String,
}

/// One journal line, as far as a later run reads it.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Line {
    entry: String,
    dry_run: bool,
    canonical_verified: bool,
    #[serde(flatten)]
    recorded: Recorded,
}

/// For each entry, the last line whose salvage ref was verified on
/// canonical. A missing journal is empty; lines that do not parse (one cut
/// short by a full disk) are passed over.
pub(super) fn verified_refs(settings: &Settings) -> Result<BTreeMap<String, Recorded>> {
    let path = settings.salvage_dir().join(JOURNAL);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error).with_context(|| format!("failed to read {path:?}")),
    };
    let mut verified = BTreeMap::new();
    for text in std::io::BufReader::new(file).split(b'\n') {
        let text = text.with_context(|| format!("failed to read {path:?}"))?;
        let Ok(line) = serde_json::from_slice::<Line>(&text) else {
            continue;
        };
        if line.dry_run
            || !line.canonical_verified
            || line.recorded.salvage_ref.is_none()
            || line.recorded.salvage_rev.is_none()
        {
            continue;
        }
        verified.insert(line.entry, line.recorded);
    }
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_verified_line_of_each_entry_is_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".salvage")).unwrap();
        let settings = Settings {
            root: root.clone(),
            node: "node-1".to_string(),
            apply: true,
            remove: false,
            projects: Vec::new(),
            acks: Vec::new(),
            remote_base: "file:///nowhere".to_string(),
            identity: crate::workspace_git::GitIdentity::new("a", "b@example.com"),
            min_free_bytes: 0,
        };
        assert!(verified_refs(&settings).unwrap().is_empty());
        let lines = [
            r#"{"entry":"a","dryRun":false,"canonicalVerified":true,"head":"h1","sourceTree":"t1","salvageRef":"refs/instafy/salvage/gateway/n-1","salvageRev":"r1","skippedPaths":[{"path":"x.zip","size":0,"reason":"policy"}]}"#,
            // A later line without a verified ref keeps the earlier one.
            r#"{"entry":"a","dryRun":false,"canonicalVerified":false,"salvageRef":"refs/instafy/salvage/gateway/n-2","salvageRev":"r2"}"#,
            r#"{"entry":"b","dryRun":false,"canonicalVerified":true,"salvageRef":"refs/instafy/salvage/gateway/n-3","salvageRev":"r3","historyFiltered":true}"#,
            r#"{"entry":"b","dryRun":false,"canonicalVerified":true,"salvageRef":"refs/instafy/salvage/gateway/n-4","salvageRev":"r4"}"#,
            r#"{"entry":"c","dryRun":true,"canonicalVerified":true,"salvageRef":"refs/instafy/salvage/gateway/n-5","salvageRev":"r5"}"#,
            r#"{"entry":"d","dryRun":false,"canonicalVer"#,
        ];
        for line in lines {
            append(&settings, line).unwrap();
        }
        let verified = verified_refs(&settings).unwrap();
        assert_eq!(verified.len(), 2, "{verified:?}");
        assert_eq!(
            verified["a"],
            Recorded {
                head: Some("h1".to_string()),
                source_tree: Some("t1".to_string()),
                salvage_ref: Some("refs/instafy/salvage/gateway/n-1".to_string()),
                salvage_rev: Some("r1".to_string()),
                history_filtered: false,
                skipped_paths: vec![RecordedSkip {
                    path: "x.zip".to_string(),
                    size: 0,
                    reason: "policy".to_string(),
                }],
            }
        );
        assert_eq!(verified["b"].salvage_rev.as_deref(), Some("r4"));
        assert!(!verified["b"].history_filtered);
    }
}
