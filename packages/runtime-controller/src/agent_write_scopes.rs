use std::collections::{HashMap, HashSet};

use serde_json::{json, Map as JsonMap, Value as JsonValue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentWriteScopeMode {
    Owned,
    ReadOnly,
    CoordinationRequired,
    Unscoped,
}

impl AgentWriteScopeMode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Owned => "owned",
            Self::ReadOnly => "read_only",
            Self::CoordinationRequired => "coordination_required",
            Self::Unscoped => "unscoped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentWriteScopeConflict {
    reason: String,
    agents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentWriteScopeAssignment {
    mode: AgentWriteScopeMode,
    owned_paths: Vec<String>,
    read_only_paths: Vec<String>,
    rationale: String,
    source: String,
    conflict: Option<AgentWriteScopeConflict>,
}

impl AgentWriteScopeAssignment {
    fn read_only(rationale: impl Into<String>) -> Self {
        Self {
            mode: AgentWriteScopeMode::ReadOnly,
            owned_paths: Vec::new(),
            read_only_paths: Vec::new(),
            rationale: rationale.into(),
            source: "dispatch".to_string(),
            conflict: None,
        }
    }

    fn owned(paths: Vec<String>, rationale: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            mode: AgentWriteScopeMode::Owned,
            owned_paths: paths,
            read_only_paths: Vec::new(),
            rationale: rationale.into(),
            source: source.into(),
            conflict: None,
        }
    }

    fn unscoped(rationale: impl Into<String>) -> Self {
        Self {
            mode: AgentWriteScopeMode::Unscoped,
            owned_paths: Vec::new(),
            read_only_paths: Vec::new(),
            rationale: rationale.into(),
            source: "dispatch".to_string(),
            conflict: None,
        }
    }

    fn coordination_required(
        mut self,
        reason: impl Into<String>,
        agents: Vec<String>,
        rationale: impl Into<String>,
    ) -> Self {
        self.mode = AgentWriteScopeMode::CoordinationRequired;
        self.rationale = rationale.into();
        self.conflict = Some(AgentWriteScopeConflict {
            reason: reason.into(),
            agents,
        });
        self
    }

    pub(crate) fn is_coordination_required(&self) -> bool {
        self.mode == AgentWriteScopeMode::CoordinationRequired
    }

    pub(crate) fn rationale(&self) -> &str {
        self.rationale.as_str()
    }

    pub(crate) fn to_json(&self) -> JsonValue {
        let mut map = JsonMap::new();
        map.insert(
            "mode".to_string(),
            JsonValue::String(self.mode.as_str().to_string()),
        );
        map.insert(
            "ownedPaths".to_string(),
            JsonValue::Array(
                self.owned_paths
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        );
        map.insert(
            "readOnlyPaths".to_string(),
            JsonValue::Array(
                self.read_only_paths
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        );
        map.insert(
            "rationale".to_string(),
            JsonValue::String(self.rationale.clone()),
        );
        map.insert("source".to_string(), JsonValue::String(self.source.clone()));
        if self.mode == AgentWriteScopeMode::CoordinationRequired {
            map.insert("coordinationRequired".to_string(), JsonValue::Bool(true));
        }
        if let Some(conflict) = self.conflict.as_ref() {
            map.insert(
                "conflict".to_string(),
                json!({
                    "reason": conflict.reason,
                    "agents": conflict.agents,
                }),
            );
        }
        JsonValue::Object(map)
    }
}

pub(crate) fn build_agent_write_scope_plan(
    metadata: &JsonValue,
    _prompt_text: &str,
    target_handles: &[String],
    _prompt_segments: &HashMap<String, String>,
) -> HashMap<String, AgentWriteScopeAssignment> {
    let write_intent = metadata
        .as_object()
        .and_then(|metadata| metadata.get("writeIntent"))
        .and_then(parse_runtime_bool)
        .unwrap_or(false);
    let multi_agent = target_handles.len() > 1;
    let mut assignments = HashMap::new();

    for handle in target_handles {
        let assignment =
            match extract_explicit_agent_write_scope(metadata, handle, target_handles.len()) {
                Some(assignment) => assignment,
                None if !write_intent && !multi_agent => continue,
                None if !write_intent => AgentWriteScopeAssignment::read_only(
                    "request metadata does not declare workspace writes",
                ),
                None if multi_agent => AgentWriteScopeAssignment::unscoped(
                    "write-heavy multi-agent work needs explicit disjoint ownership",
                ),
                None => AgentWriteScopeAssignment::unscoped(
                    "single-agent write job has no sibling write scope to coordinate with",
                ),
            };
        assignments.insert(handle.clone(), assignment);
    }

    let has_write_claim = assignments
        .values()
        .any(|assignment| assignment.mode != AgentWriteScopeMode::ReadOnly);
    if multi_agent && (write_intent || has_write_claim) {
        mark_unsafe_multi_agent_write_scopes(&mut assignments);
    }

    assignments
}

pub(crate) fn apply_agent_write_scope_metadata(
    metadata: &mut JsonValue,
    assignment: Option<&AgentWriteScopeAssignment>,
) {
    let Some(assignment) = assignment else {
        return;
    };
    let claim = assignment.to_json();
    let map = ensure_object(metadata);
    map.insert("writeScope".to_string(), claim.clone());

    let agent = map
        .entry("agent".to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if !agent.is_object() {
        *agent = JsonValue::Object(JsonMap::new());
    }
    if let Some(agent_map) = agent.as_object_mut() {
        agent_map.insert("writeScope".to_string(), claim.clone());
    }

    if let Some(collaboration) = map.get_mut("agentCollaboration") {
        if !collaboration.is_object() {
            *collaboration = JsonValue::Object(JsonMap::new());
        }
        if let Some(collaboration_map) = collaboration.as_object_mut() {
            collaboration_map.insert("writeScope".to_string(), claim);
        }
    }
}

fn mark_unsafe_multi_agent_write_scopes(
    assignments: &mut HashMap<String, AgentWriteScopeAssignment>,
) {
    let writing_handles: Vec<String> = assignments
        .iter()
        .filter_map(|(handle, assignment)| {
            if assignment.mode == AgentWriteScopeMode::ReadOnly {
                None
            } else {
                Some(handle.clone())
            }
        })
        .collect();

    if writing_handles.len() <= 1 {
        return;
    }

    let missing_scope = writing_handles.iter().any(|handle| {
        assignments
            .get(handle)
            .map(|assignment| assignment.owned_paths.is_empty())
            .unwrap_or(false)
    });
    if missing_scope {
        let agents = sorted_agents(writing_handles.iter().cloned());
        for handle in writing_handles {
            if let Some(existing) = assignments.remove(&handle) {
                assignments.insert(
                    handle,
                    existing.coordination_required(
                        "missing_write_scope",
                        agents.clone(),
                        "write-heavy sibling agents need explicit disjoint owned paths before concurrent edits",
                    ),
                );
            }
        }
        return;
    }

    let mut overlapping_agents = HashSet::<String>::new();
    let mut handles = writing_handles;
    handles.sort();
    for (index, left_handle) in handles.iter().enumerate() {
        let Some(left) = assignments.get(left_handle) else {
            continue;
        };
        for right_handle in handles.iter().skip(index + 1) {
            let Some(right) = assignments.get(right_handle) else {
                continue;
            };
            if write_scopes_overlap(&left.owned_paths, &right.owned_paths) {
                overlapping_agents.insert(left_handle.clone());
                overlapping_agents.insert(right_handle.clone());
            }
        }
    }

    if overlapping_agents.is_empty() {
        return;
    }

    let agents = sorted_agents(overlapping_agents.iter().cloned());
    for handle in overlapping_agents {
        if let Some(existing) = assignments.remove(&handle) {
            assignments.insert(
                handle,
                existing.coordination_required(
                    "overlapping_write_scope",
                    agents.clone(),
                    "write-heavy sibling agents have overlapping owned paths and need manual coordination",
                ),
            );
        }
    }
}

fn extract_explicit_agent_write_scope(
    metadata: &JsonValue,
    handle: &str,
    target_count: usize,
) -> Option<AgentWriteScopeAssignment> {
    let metadata_map = metadata.as_object()?;
    let handle = normalize_agent_handle(handle)?;

    for container in [
        metadata_map
            .get("agentSelection")
            .and_then(JsonValue::as_object)
            .and_then(|selection| {
                selection
                    .get("writeScopes")
                    .or_else(|| selection.get("write_scopes"))
            }),
        metadata_map
            .get("agentWriteScopes")
            .or_else(|| metadata_map.get("agent_write_scopes")),
        metadata_map
            .get("writeScopes")
            .or_else(|| metadata_map.get("write_scopes")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(scope) =
            lookup_agent_scoped_value(container, &handle).and_then(parse_agent_write_scope_value)
        {
            return Some(scope);
        }
    }

    if target_count == 1 {
        metadata_map
            .get("writeScope")
            .or_else(|| metadata_map.get("write_scope"))
            .and_then(parse_agent_write_scope_value)
    } else {
        None
    }
}

fn lookup_agent_scoped_value<'a>(container: &'a JsonValue, handle: &str) -> Option<&'a JsonValue> {
    let map = container.as_object()?;
    for key in [handle.to_string(), format!("@{handle}")] {
        if let Some(value) = map.get(&key) {
            return Some(value);
        }
    }

    map.iter().find_map(|(key, value)| {
        normalize_agent_handle(key)
            .filter(|normalized| normalized == handle)
            .map(|_| value)
    })
}

fn parse_agent_write_scope_value(value: &JsonValue) -> Option<AgentWriteScopeAssignment> {
    match value {
        JsonValue::String(raw) => {
            let normalized = raw.trim().to_ascii_lowercase().replace('-', "_");
            if normalized == "read_only" || normalized == "readonly" {
                return Some(AgentWriteScopeAssignment::read_only(
                    "explicit read-only write scope",
                ));
            }
            normalize_write_scope_path(raw).map(|path| {
                AgentWriteScopeAssignment::owned(
                    vec![path],
                    "explicit single-path write scope",
                    "metadata",
                )
            })
        }
        JsonValue::Array(_) => {
            let paths = collect_scope_path_list(value);
            if paths.is_empty() {
                None
            } else {
                Some(AgentWriteScopeAssignment::owned(
                    paths,
                    "explicit owned paths from metadata",
                    "metadata",
                ))
            }
        }
        JsonValue::Object(map) => {
            let mode = map
                .get("mode")
                .or_else(|| map.get("status"))
                .and_then(JsonValue::as_str)
                .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"));
            let rationale = map
                .get("rationale")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("explicit write scope metadata")
                .to_string();
            let mut owned_paths = Vec::new();
            for key in [
                "ownedPaths",
                "owned_paths",
                "paths",
                "pathGlobs",
                "path_globs",
                "ownedPathGlobs",
                "owned_path_globs",
            ] {
                if let Some(value) = map.get(key) {
                    owned_paths.extend(collect_scope_path_list(value));
                }
            }
            owned_paths = unique_paths(owned_paths);

            let mut read_only_paths = Vec::new();
            for key in ["readOnlyPaths", "read_only_paths"] {
                if let Some(value) = map.get(key) {
                    read_only_paths.extend(collect_read_only_scope_path_list(value));
                }
            }
            read_only_paths = unique_paths(read_only_paths);

            if mode.as_deref() == Some("read_only")
                || map
                    .get("readOnly")
                    .or_else(|| map.get("read_only"))
                    .and_then(parse_runtime_bool)
                    .unwrap_or(false)
            {
                let mut assignment = AgentWriteScopeAssignment::read_only(rationale);
                assignment.read_only_paths = read_only_paths;
                assignment.source = "metadata".to_string();
                return Some(assignment);
            }

            if mode.as_deref() == Some("coordination_required") {
                let mut assignment = AgentWriteScopeAssignment::unscoped(rationale.clone())
                    .coordination_required("explicit_coordination_required", Vec::new(), rationale);
                assignment.owned_paths = owned_paths;
                assignment.read_only_paths = read_only_paths;
                assignment.source = "metadata".to_string();
                return Some(assignment);
            }

            if !owned_paths.is_empty() {
                let mut assignment =
                    AgentWriteScopeAssignment::owned(owned_paths, rationale, "metadata");
                assignment.read_only_paths = read_only_paths;
                return Some(assignment);
            }

            None
        }
        _ => None,
    }
}

fn collect_scope_path_list(value: &JsonValue) -> Vec<String> {
    match value {
        JsonValue::String(raw) => normalize_write_scope_path(raw).into_iter().collect(),
        JsonValue::Array(items) => unique_paths(
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(normalize_write_scope_path)
                .collect(),
        ),
        _ => Vec::new(),
    }
}

fn collect_read_only_scope_path_list(value: &JsonValue) -> Vec<String> {
    match value {
        JsonValue::String(raw) => normalize_read_only_scope_path(raw).into_iter().collect(),
        JsonValue::Array(items) => unique_paths(
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(normalize_read_only_scope_path)
                .collect(),
        ),
        _ => Vec::new(),
    }
}

fn normalize_write_scope_path(raw: &str) -> Option<String> {
    let raw_trimmed = raw.trim();
    if raw_trimmed.starts_with("http://") || raw_trimmed.starts_with("https://") {
        return None;
    }

    let mut value = raw
        .trim()
        .trim_matches(|ch: char| {
            matches!(
                ch,
                ',' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}'
            )
        })
        .trim_end_matches('.')
        .trim_start_matches("./")
        .replace('\\', "/");
    while value.contains("//") {
        value = value.replace("//", "/");
    }

    if value.is_empty()
        || value.starts_with('/')
        || value.starts_with('@')
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("http:/")
        || value.starts_with("https:/")
        || value.contains("..")
        || value.chars().any(char::is_whitespace)
    {
        return None;
    }

    let path_like = value.contains('/')
        || value.contains('*')
        || value.rsplit_once('.').is_some_and(|(_, extension)| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "js" | "jsx"
                    | "ts"
                    | "tsx"
                    | "rs"
                    | "css"
                    | "scss"
                    | "html"
                    | "md"
                    | "mdx"
                    | "json"
                    | "toml"
                    | "yaml"
                    | "yml"
                    | "sql"
                    | "py"
                    | "go"
                    | "sh"
            )
        });
    if !path_like {
        return None;
    }

    Some(value)
}

fn normalize_read_only_scope_path(raw: &str) -> Option<String> {
    let raw_trimmed = raw.trim();
    if raw_trimmed.starts_with("http://") || raw_trimmed.starts_with("https://") {
        return None;
    }

    let mut value = raw_trimmed
        .trim_matches(|ch: char| {
            matches!(
                ch,
                ',' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}'
            )
        })
        .trim_end_matches('.')
        .replace('\\', "/");
    while value.contains("//") {
        value = value.replace("//", "/");
    }

    if value.starts_with("/tmp/")
        || value.starts_with("/var/folders/")
        || value.starts_with("/workspace/")
        || value.starts_with("/workspaces/")
    {
        return Some(value);
    }

    normalize_write_scope_path(raw)
}

fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if seen.insert(path.clone()) {
            out.push(path);
        }
        if out.len() >= 12 {
            break;
        }
    }
    out
}

fn write_scopes_overlap(left: &[String], right: &[String]) -> bool {
    left.iter().any(|left_path| {
        right
            .iter()
            .any(|right_path| write_scope_paths_overlap(left_path, right_path))
    })
}

fn write_scope_paths_overlap(left: &str, right: &str) -> bool {
    let left = write_scope_prefix(left);
    let right = write_scope_prefix(right);
    left == "**"
        || right == "**"
        || left == right
        || left
            .strip_suffix('/')
            .is_some_and(|prefix| right.starts_with(prefix))
        || right
            .strip_suffix('/')
            .is_some_and(|prefix| left.starts_with(prefix))
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
}

fn write_scope_prefix(path: &str) -> String {
    let mut prefix = path
        .split('*')
        .next()
        .unwrap_or(path)
        .trim()
        .trim_start_matches("./")
        .replace('\\', "/");
    while prefix.ends_with('/') && prefix.len() > 1 {
        prefix.pop();
    }
    if prefix.is_empty() {
        "**".to_string()
    } else {
        prefix
    }
}

fn sorted_agents(handles: impl Iterator<Item = String>) -> Vec<String> {
    let mut values: Vec<String> = handles
        .map(|handle| format!("@{}", handle.trim().trim_start_matches('@')))
        .collect();
    values.sort();
    values.dedup();
    values
}

fn ensure_object(value: &mut JsonValue) -> &mut JsonMap<String, JsonValue> {
    if !matches!(value, JsonValue::Object(_)) {
        *value = JsonValue::Object(JsonMap::new());
    }
    value.as_object_mut().expect("value must be object")
}

fn normalize_agent_handle(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('@').trim().to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 20 {
        return None;
    }
    if !trimmed
        .chars()
        .next()
        .map(|ch| ch.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(trimmed)
}

fn parse_runtime_bool(value: &JsonValue) -> Option<bool> {
    match value {
        JsonValue::Bool(value) => Some(*value),
        JsonValue::Number(value) => value.as_i64().map(|number| number != 0),
        JsonValue::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" | "required" | "require" => Some(true),
            "0" | "false" | "no" | "off" | "none" | "optional" | "disabled" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_multi_agent_write_scopes_require_coordination() {
        let metadata = json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"]
            }
        });
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = HashMap::from([
            (
                "ben".to_string(),
                "@ben edit src/auth/Login.tsx.".to_string(),
            ),
            ("octo".to_string(), "@octo update docs/Auth.md.".to_string()),
        ]);

        let plan = build_agent_write_scope_plan(
            &metadata,
            "@ben edit src/auth/Login.tsx. @octo update docs/Auth.md.",
            &handles,
            &segments,
        );

        assert_eq!(plan["ben"].mode, AgentWriteScopeMode::CoordinationRequired);
        assert_eq!(plan["octo"].mode, AgentWriteScopeMode::CoordinationRequired);
        assert_eq!(
            plan["ben"]
                .conflict
                .as_ref()
                .map(|conflict| conflict.reason.as_str()),
            Some("missing_write_scope")
        );
        assert!(plan["ben"].owned_paths.is_empty());
        assert!(plan["octo"].owned_paths.is_empty());
    }

    #[test]
    fn accepts_disjoint_explicit_paths() {
        let metadata = json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"],
                "writeScopes": {
                    "ben": ["src/auth/Login.tsx"],
                    "octo": ["docs/Auth.md"]
                }
            }
        });
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "@ben edit src/auth/Login.tsx. @octo update docs/Auth.md.",
            &handles,
            &segments,
        );

        assert_eq!(plan["ben"].mode, AgentWriteScopeMode::Owned);
        assert_eq!(plan["ben"].owned_paths, vec!["src/auth/Login.tsx"]);
        assert_eq!(plan["octo"].mode, AgentWriteScopeMode::Owned);
        assert_eq!(plan["octo"].owned_paths, vec!["docs/Auth.md"]);
    }

    #[test]
    fn marks_overlapping_explicit_paths_coordination_required() {
        let metadata = json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"],
                "writeScopes": {
                    "ben": ["src/App.tsx"],
                    "octo": ["src/App.tsx"]
                }
            }
        });
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "@ben edit src/App.tsx. @octo also update src/App.tsx.",
            &handles,
            &segments,
        );

        assert_eq!(plan["ben"].mode, AgentWriteScopeMode::CoordinationRequired);
        assert_eq!(plan["octo"].mode, AgentWriteScopeMode::CoordinationRequired);
        assert_eq!(
            plan["ben"]
                .conflict
                .as_ref()
                .map(|conflict| conflict.reason.as_str()),
            Some("overlapping_write_scope")
        );
    }

    #[test]
    fn marks_explicit_overlapping_scopes_even_without_write_intent_flag() {
        let metadata = json!({
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"],
                "writeScopes": {
                    "ben": ["src/App.tsx"],
                    "octo": ["src/**"]
                }
            }
        });
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "@ben work on app. @octo work on source.",
            &handles,
            &segments,
        );

        assert_eq!(plan["ben"].mode, AgentWriteScopeMode::CoordinationRequired);
        assert_eq!(plan["octo"].mode, AgentWriteScopeMode::CoordinationRequired);
    }

    #[test]
    fn keeps_read_only_agents_unrestricted() {
        let metadata = json!({
            "writeIntent": false,
            "agentSelection": {
                "active": ["ben", "octo"],
                "mentions": ["ben", "octo"]
            }
        });
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "@ben inspect src/App.tsx. @octo explain docs/Auth.md.",
            &handles,
            &segments,
        );

        assert_eq!(plan["ben"].mode, AgentWriteScopeMode::ReadOnly);
        assert_eq!(plan["octo"].mode, AgentWriteScopeMode::ReadOnly);
    }

    #[test]
    fn omits_default_scope_for_single_agent_without_write_intent() {
        let metadata = json!({
            "writeIntent": false,
            "agentSelection": {
                "active": ["octo"],
                "mentions": ["octo"]
            }
        });
        let handles = vec!["octo".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "Create a tiny workspace file.",
            &handles,
            &segments,
        );

        assert!(plan.is_empty());
    }

    #[test]
    fn preserves_runtime_local_read_only_paths() {
        let metadata = json!({
            "writeIntent": false,
            "agentSelection": {
                "active": ["alpha"],
                "mentions": ["alpha"],
                "writeScopes": {
                    "alpha": {
                        "mode": "read_only",
                        "readOnlyPaths": [
                            "/tmp/runtime-local/repo/packages/borsh/src/binary.ts",
                            "/workspace/project/sources/repo/packages/borsh/src/index.ts",
                            "handoff/repo/handoff.txt",
                            "packages/borsh/src/bigint.ts"
                        ]
                    }
                }
            }
        });
        let handles = vec!["alpha".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "Read-only prepared source review.",
            &handles,
            &segments,
        );

        assert_eq!(plan["alpha"].mode, AgentWriteScopeMode::ReadOnly);
        assert_eq!(
            plan["alpha"].read_only_paths,
            vec![
                "/tmp/runtime-local/repo/packages/borsh/src/binary.ts",
                "/workspace/project/sources/repo/packages/borsh/src/index.ts",
                "handoff/repo/handoff.txt",
                "packages/borsh/src/bigint.ts"
            ]
        );
        assert!(plan["alpha"].owned_paths.is_empty());
    }

    #[test]
    fn rejects_absolute_owned_paths() {
        let metadata = json!({
            "writeIntent": true,
            "agentSelection": {
                "active": ["alpha"],
                "mentions": ["alpha"],
                "writeScopes": {
                    "alpha": {
                        "mode": "owned",
                        "ownedPaths": ["/tmp/not-workspace/file.ts"]
                    }
                }
            }
        });
        let handles = vec!["alpha".to_string()];
        let segments = HashMap::new();

        let plan = build_agent_write_scope_plan(
            &metadata,
            "Write a file, but the absolute ownership path is unsafe.",
            &handles,
            &segments,
        );

        assert_eq!(plan["alpha"].mode, AgentWriteScopeMode::Unscoped);
        assert!(plan["alpha"].owned_paths.is_empty());
    }

    #[test]
    fn preserves_claim_on_agent_and_collaboration_metadata() {
        let mut metadata = json!({
            "agent": {
                "handle": "octo"
            },
            "agentCollaboration": {
                "mode": "thread"
            }
        });
        let assignment = AgentWriteScopeAssignment::owned(
            vec!["src/App.tsx".to_string()],
            "explicit owned path",
            "metadata",
        );

        apply_agent_write_scope_metadata(&mut metadata, Some(&assignment));

        assert_eq!(metadata["writeScope"]["mode"], json!("owned"));
        assert_eq!(
            metadata["agent"]["writeScope"]["ownedPaths"],
            json!(["src/App.tsx"])
        );
        assert_eq!(
            metadata["agentCollaboration"]["writeScope"]["rationale"],
            json!("explicit owned path")
        );
    }
}
