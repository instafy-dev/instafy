//! The words a skill pack gives its commands in a chat turn's activity line
//! (docs/Chat-Activity.md, docs/Skill-Packs.md "Activity labels").
//!
//! A pack names its commands in `bin` and labels their subcommands in `activity`:
//!
//! ```json
//! "bin": { "uw": "scripts/uw.mjs" },
//! "activity": { "uw": {
//!   "add-point": { "live": "Looking up places",
//!                  "done": { "one": "looked up a place", "other": "looked up {n} places",
//!                            "some": "looked up places" } },
//!   "validate":  { "live": "Checking the map", "done": "built the map",
//!                  "role": "outcome", "when": "success" },
//!   "*":         { "live": "Working on the map", "role": "quiet" } } }
//! ```
//!
//! Only packs installed with the runtime supply labels (their sha256 pin is the trust root); a
//! pack a space imports itself never does. Every label follows the rules of
//! `runtime_contracts::chat_activity`. An `activity` block that breaks one is dropped as a whole,
//! with a warning, and the pack keeps loading.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use runtime_contracts::chat_activity::{is_done_form, is_live_label};
use serde_json::Value;
use tracing::warn;

use super::{
    InstalledPack, PACK_MANIFEST, installed_packs, is_plain_relative_path, is_regular_file,
};

/// At most this many labelled subcommands per command.
pub const MAX_SUBCOMMANDS: usize = 64;
/// At most this many commands per pack.
pub const MAX_BINS: usize = 8;
/// Names a pack command may never take: they would shadow the tools every turn relies on.
pub const RESERVED_BIN_NAMES: &[&str] = &[
    "instafy",
    "node",
    "npm",
    "npx",
    "pnpm",
    "pnpx",
    "yarn",
    "corepack",
    "git",
    "sh",
    "bash",
    "zsh",
    "dash",
    "env",
    "python",
    "python3",
    "pip",
    "codex",
    "runtime-agent",
    "curl",
    "wget",
    "sudo",
    "make",
];

/// How a step counts in the turn's summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityRole {
    /// What the turn did ("looked up 14 places"); the two biggest are named.
    Content,
    /// What the turn made ("built the map"); the latest is named last.
    Outcome,
    /// Shown only while it runs and in Details.
    Quiet,
}

impl ActivityRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Outcome => "outcome",
            Self::Quiet => "quiet",
        }
    }
}

/// The words for a step once the turn is done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DoneLabel {
    /// One form for any count ("built the map").
    Single(String),
    /// `one` for a single step, `other` with `{n}`, `some` when the count is not known.
    Counted {
        one: String,
        other: Option<String>,
        some: Option<String>,
    },
}

impl DoneLabel {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Single(text) => Value::from(text.as_str()),
            Self::Counted { one, other, some } => {
                let mut forms = serde_json::Map::new();
                forms.insert("one".into(), Value::from(one.as_str()));
                if let Some(other) = other {
                    forms.insert("other".into(), Value::from(other.as_str()));
                }
                if let Some(some) = some {
                    forms.insert("some".into(), Value::from(some.as_str()));
                }
                Value::Object(forms)
            }
        }
    }
}

/// One subcommand's label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityLabel {
    pub live: String,
    pub done: Option<DoneLabel>,
    pub role: ActivityRole,
    /// `when: "success"`: the step counts only when the command exits 0.
    pub success_only: bool,
}

/// An installed pack's commands and their labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackActivity {
    pub pack: String,
    pub dir: PathBuf,
    /// Command name to its entry inside the pack.
    pub bins: BTreeMap<String, String>,
    /// The launcher path inside the space's skill folder (`cli.space_path`) and the command its
    /// entry is, when one of the commands runs the pack's `cli` entry.
    pub launcher: Option<(String, String)>,
    /// Command name to subcommand (or `*`) to label.
    pub labels: BTreeMap<String, BTreeMap<String, ActivityLabel>>,
}

/// A command name a pack may declare: `^[a-z][a-z0-9-]{1,31}$`, not reserved.
pub fn is_pack_bin_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !RESERVED_BIN_NAMES.contains(&name)
}

fn is_subcommand_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    key == "*"
        || (!bytes.is_empty()
            && bytes.len() <= 32
            && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-'))
}

fn parse_done(value: &Value) -> Result<DoneLabel, String> {
    match value {
        Value::String(text) if is_done_form(text, false, false) => {
            Ok(DoneLabel::Single(text.clone()))
        }
        Value::Object(forms) => {
            if let Some(unknown) = forms
                .keys()
                .find(|key| !matches!(key.as_str(), "one" | "other" | "some"))
            {
                return Err(format!("done has an unknown form {unknown:?}"));
            }
            let form = |key: &str, count: bool| -> Result<Option<String>, String> {
                match forms.get(key) {
                    None => Ok(None),
                    Some(Value::String(text)) if is_done_form(text, count, false) => {
                        Ok(Some(text.clone()))
                    }
                    Some(other) => Err(format!("done.{key} {other} breaks the label rules")),
                }
            };
            let one = form("one", false)?.ok_or("done needs a `one` form")?;
            let other = form("other", true)?;
            let some = form("some", false)?;
            if other.is_some() && some.is_none() {
                return Err("done needs a `some` form with `other`".into());
            }
            Ok(DoneLabel::Counted { one, other, some })
        }
        other => Err(format!("done {other} breaks the label rules")),
    }
}

fn parse_label(value: &Value) -> Result<ActivityLabel, String> {
    let object = value.as_object().ok_or("a label is an object")?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !matches!(key.as_str(), "live" | "done" | "role" | "when"))
    {
        return Err(format!("unknown field {unknown:?}"));
    }
    let live = object
        .get("live")
        .and_then(Value::as_str)
        .filter(|live| is_live_label(live, false))
        .ok_or_else(|| format!("live {:?} breaks the label rules", object.get("live")))?;
    let role = match object.get("role").map(|role| role.as_str()) {
        None => ActivityRole::Content,
        Some(Some("content")) => ActivityRole::Content,
        Some(Some("outcome")) => ActivityRole::Outcome,
        Some(Some("quiet")) => ActivityRole::Quiet,
        Some(_) => {
            return Err(format!(
                "role {:?} is not content, outcome or quiet",
                object["role"]
            ));
        }
    };
    let done = object.get("done").map(parse_done).transpose()?;
    if done.is_none() && role != ActivityRole::Quiet {
        return Err("a content or outcome label needs done words".into());
    }
    let success_only = match object.get("when").map(|when| when.as_str()) {
        None => false,
        Some(Some("success")) => true,
        Some(_) => return Err(format!("when {:?} is not \"success\"", object["when"])),
    };
    Ok(ActivityLabel {
        live: live.to_string(),
        done,
        role,
        success_only,
    })
}

/// Reads `bin` and `activity` from an installed pack's manifest. `Ok(None)` when the pack labels
/// nothing; `Err` names the first rule its `activity` breaks.
pub fn read_pack_activity(pack: &InstalledPack) -> Result<Option<PackActivity>, String> {
    let raw = std::fs::read(pack.dir.join(PACK_MANIFEST)).map_err(|error| error.to_string())?;
    let manifest: Value = serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    let Some(activity) = manifest.get("activity") else {
        return Ok(None);
    };
    let activity = activity.as_object().ok_or("activity is not an object")?;
    let bin = manifest
        .get("bin")
        .and_then(Value::as_object)
        .ok_or("activity labels only commands declared in `bin`")?;
    if bin.len() > MAX_BINS {
        return Err(format!("bin declares more than {MAX_BINS} commands"));
    }
    let mut bins = BTreeMap::new();
    for (name, entry) in bin {
        let entry = entry.as_str().unwrap_or_default();
        if !is_pack_bin_name(name) {
            return Err(format!(
                "bin {name:?} is not a command name a pack may declare"
            ));
        }
        if !is_plain_relative_path(entry) || !is_regular_file(&pack.dir.join(entry)) {
            return Err(format!(
                "bin {name:?}: {entry:?} is not a file inside the pack"
            ));
        }
        bins.insert(name.clone(), entry.to_string());
    }
    let mut labels = BTreeMap::new();
    for (name, subcommands) in activity {
        if !bins.contains_key(name) {
            return Err(format!("activity {name:?} is not a command in `bin`"));
        }
        let subcommands = subcommands
            .as_object()
            .ok_or_else(|| format!("activity {name:?} is not an object"))?;
        if subcommands.len() > MAX_SUBCOMMANDS {
            return Err(format!(
                "activity {name:?} labels more than {MAX_SUBCOMMANDS} subcommands"
            ));
        }
        let mut parsed = BTreeMap::new();
        for (subcommand, label) in subcommands {
            if !is_subcommand_key(subcommand) {
                return Err(format!(
                    "activity {name:?}: {subcommand:?} is not a subcommand name"
                ));
            }
            let label = parse_label(label)
                .map_err(|error| format!("activity {name}.{subcommand}: {error}"))?;
            parsed.insert(subcommand.clone(), label);
        }
        labels.insert(name.clone(), parsed);
    }
    let launcher = pack.cli.as_ref().and_then(|cli| {
        bins.iter()
            .find(|(_, entry)| **entry == cli.entry)
            .map(|(name, _)| (cli.space_path.clone(), name.clone()))
    });
    Ok(Some(PackActivity {
        pack: pack.name.clone(),
        dir: pack.dir.clone(),
        bins,
        launcher,
        labels,
    }))
}

/// The labels of `packs`, skipping (with a warning) any pack whose `activity` breaks a rule.
pub fn pack_activities(packs: &[InstalledPack]) -> Vec<PackActivity> {
    let mut activities = Vec::new();
    for pack in packs {
        match read_pack_activity(pack) {
            Ok(Some(activity)) => activities.push(activity),
            Ok(None) => {}
            Err(error) => warn!(
                pack = %pack.name,
                %error,
                "dropping a skill pack's activity labels that break the label rules; the pack still loads"
            ),
        }
    }
    // A command two packs declare belongs to neither.
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for activity in &activities {
        for name in activity.bins.keys() {
            *seen.entry(name.clone()).or_default() += 1;
        }
    }
    for activity in &mut activities {
        activity.bins.retain(|name, _| seen.get(name) == Some(&1));
        activity.labels.retain(|name, _| seen.get(name) == Some(&1));
        if activity
            .launcher
            .as_ref()
            .is_some_and(|(_, name)| seen.get(name) != Some(&1))
        {
            activity.launcher = None;
        }
    }
    activities
}

/// The labels of the packs installed with this runtime, read once.
pub fn installed_pack_activities() -> &'static [PackActivity] {
    static ACTIVITIES: OnceLock<Vec<PackActivity>> = OnceLock::new();
    ACTIVITIES.get_or_init(|| pack_activities(installed_packs()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::{list_packs, load_pack, tests::make_pack};
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::Path;

    /// The maps pack's labels as v0.1.3 declares them, on a test pack with a `uw` command.
    pub(crate) fn map_activity() -> Value {
        json!({
            "uw": {
                "add-point": { "live": "Looking up places",
                    "done": { "one": "looked up a place", "other": "looked up {n} places", "some": "looked up places" } },
                "cite": { "live": "Reading a source",
                    "done": { "one": "read a source", "other": "read {n} sources", "some": "read sources" } },
                "validate": { "live": "Checking the map", "done": "built the map", "role": "outcome", "when": "success" },
                "fit": { "live": "Framing the map", "role": "quiet" },
                "*": { "live": "Working on the map", "role": "quiet" }
            }
        })
    }

    /// `<root>/<name>` with `scripts/run.mjs` as the `cli` entry, `bin` and `activity`.
    pub(crate) fn make_labelled_pack(
        root: &Path,
        name: &str,
        bin: &str,
        activity: Value,
    ) -> PathBuf {
        let dir = make_pack(root, name, true);
        let path = dir.join(PACK_MANIFEST);
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        manifest["bin"] = json!({ bin: "scripts/run.mjs" });
        manifest["activity"] = activity;
        fs::write(&path, manifest.to_string()).expect("manifest");
        dir
    }

    #[test]
    fn a_pack_declares_labels_for_its_commands() {
        let root = tempfile::tempdir().expect("tmp");
        let activity = map_activity();
        let renamed = json!({ "uw": activity["uw"].clone() });
        make_labelled_pack(root.path(), "maps", "uw", renamed);
        let packs = list_packs(root.path());
        let activities = pack_activities(&packs);
        assert_eq!(activities.len(), 1);
        let maps = &activities[0];
        assert_eq!(
            maps.bins.get("uw").map(String::as_str),
            Some("scripts/run.mjs")
        );
        assert_eq!(
            maps.launcher,
            Some(("scripts/run.mjs".to_string(), "uw".to_string()))
        );
        let add_point = &maps.labels["uw"]["add-point"];
        assert_eq!(add_point.live, "Looking up places");
        assert_eq!(add_point.role, ActivityRole::Content);
        let validate = &maps.labels["uw"]["validate"];
        assert_eq!(validate.role, ActivityRole::Outcome);
        assert!(validate.success_only);
        assert_eq!(
            validate.done,
            Some(DoneLabel::Single("built the map".into()))
        );
        assert_eq!(maps.labels["uw"]["*"].role, ActivityRole::Quiet);
    }

    #[test]
    fn an_invalid_activity_block_drops_labels_but_keeps_the_pack() {
        let root = tempfile::tempdir().expect("tmp");
        let bad_blocks = [
            json!({ "uw": { "add-point": { "live": "Visit example.com", "done": "looked up a place" } } }),
            json!({ "uw": { "add-point": { "live": "Looking up places", "done": "see https://example.com" } } }),
            json!({ "uw": { "add-point": { "live": "Looking up places",
                "done": { "one": "looked up a place", "other": "looked up places", "some": "looked up places" } } } }),
            json!({ "uw": { "add-point": { "live": "Looking up places",
                "done": { "one": "looked up a place", "other": "looked up {n} places" } } } }),
            json!({ "uw": { "add-point": { "live": "Looking up places" } } }),
            json!({ "uw": { "add-point": { "live": "Looking up places", "done": "x", "role": "loud" } } }),
            json!({ "uw": { "add-point": { "live": "Looking <b>up</b>", "done": "looked up a place" } } }),
            json!({ "other": { "x": { "live": "Working", "role": "quiet" } } }),
            json!({ "uw": { "Add Point": { "live": "Working", "role": "quiet" } } }),
            json!(["uw"]),
        ];
        for activity in bad_blocks {
            let dir = make_labelled_pack(root.path(), "maps", "uw", activity.clone());
            let pack = load_pack(&dir).expect("the pack still loads");
            assert!(read_pack_activity(&pack).is_err(), "{activity}");
            assert!(pack_activities(&[pack]).is_empty(), "{activity}");
            fs::remove_dir_all(&dir).expect("cleanup");
        }
    }

    #[test]
    fn labels_need_a_declared_command_that_is_a_file_and_not_reserved() {
        let root = tempfile::tempdir().expect("tmp");
        let labels = json!({ "*": { "live": "Working", "role": "quiet" } });
        for bin in ["git", "node", "instafy", "u", "Uw", "uw/x"] {
            let dir = make_labelled_pack(root.path(), "maps", bin, json!({ bin: labels.clone() }));
            let pack = load_pack(&dir).expect("pack");
            assert!(read_pack_activity(&pack).is_err(), "{bin}");
            fs::remove_dir_all(&dir).expect("cleanup");
        }
        let dir = make_labelled_pack(root.path(), "maps", "uw", json!({ "uw": labels }));
        let path = dir.join(PACK_MANIFEST);
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        manifest["bin"] = json!({ "uw": "scripts/missing.mjs" });
        fs::write(&path, manifest.to_string()).unwrap();
        assert!(read_pack_activity(&load_pack(&dir).unwrap()).is_err());
        manifest["bin"] = json!({ "uw": "../../etc/passwd" });
        fs::write(&path, manifest.to_string()).unwrap();
        assert!(read_pack_activity(&load_pack(&dir).unwrap()).is_err());
    }

    #[test]
    fn a_command_two_packs_declare_has_no_labels() {
        let root = tempfile::tempdir().expect("tmp");
        let labels = json!({ "uw": { "*": { "live": "Working", "role": "quiet" } } });
        make_labelled_pack(root.path(), "maps", "uw", labels.clone());
        make_labelled_pack(root.path(), "other-maps", "uw", labels);
        let activities = pack_activities(&list_packs(root.path()));
        assert!(activities.iter().all(|activity| activity.bins.is_empty()));
        assert!(activities.iter().all(|activity| activity.labels.is_empty()));
    }

    #[test]
    fn a_pack_without_activity_has_no_labels() {
        let root = tempfile::tempdir().expect("tmp");
        make_pack(root.path(), "docs-only", true);
        let packs = list_packs(root.path());
        assert_eq!(read_pack_activity(&packs[0]), Ok(None));
        assert!(pack_activities(&packs).is_empty());
    }
}
