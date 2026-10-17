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

    fn invalid_explicit_scope() -> Self {
        let rationale = "explicit write scope is invalid; provide valid paths before editing";
        let mut assignment = Self::unscoped(rationale).coordination_required(
            "invalid_write_scope",
            Vec::new(),
            rationale,
        );
        assignment.source = "metadata".to_string();
        assignment
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

    let selection = metadata_map
        .get("agentSelection")
        .and_then(JsonValue::as_object);
    let mut explicit = None;
    for container in [
        selection.and_then(|selection| selection.get("writeScopes")),
        selection.and_then(|selection| selection.get("write_scopes")),
        metadata_map.get("agentWriteScopes"),
        metadata_map.get("agent_write_scopes"),
        metadata_map.get("writeScopes"),
        metadata_map.get("write_scopes"),
    ]
    .into_iter()
    .flatten()
    {
        let Some(scopes) = container.as_object() else {
            return Some(AgentWriteScopeAssignment::invalid_explicit_scope());
        };
        for (key, value) in scopes {
            if normalize_agent_handle(key).as_deref() == Some(handle.as_str())
                && merge_explicit_scope(&mut explicit, value).is_none()
            {
                return Some(AgentWriteScopeAssignment::invalid_explicit_scope());
            }
        }
    }

    if explicit.is_some() {
        return explicit;
    }
    if target_count == 1 {
        for key in ["writeScope", "write_scope"] {
            if let Some(value) = metadata_map.get(key) {
                if merge_explicit_scope(&mut explicit, value).is_none() {
                    return Some(AgentWriteScopeAssignment::invalid_explicit_scope());
                }
            }
        }
    }
    explicit
}

fn merge_explicit_scope(
    explicit: &mut Option<AgentWriteScopeAssignment>,
    value: &JsonValue,
) -> Option<()> {
    let scope = parse_agent_write_scope_value(value)?;
    if let Some(previous) = explicit {
        if previous.mode != scope.mode
            || previous.owned_paths.iter().collect::<HashSet<_>>()
                != scope.owned_paths.iter().collect::<HashSet<_>>()
            || previous.read_only_paths.iter().collect::<HashSet<_>>()
                != scope.read_only_paths.iter().collect::<HashSet<_>>()
        {
            return None;
        }
    } else {
        *explicit = Some(scope);
    }
    Some(())
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
            let paths = collect_scope_path_list(value, normalize_write_scope_path)?;
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
            let mut mode = None;
            for key in ["mode", "status"] {
                if let Some(value) = map.get(key) {
                    let normalized = value
                        .as_str()?
                        .trim()
                        .to_ascii_lowercase()
                        .replace('-', "_");
                    let normalized = match normalized.as_str() {
                        "readonly" | "read_only" => "read_only",
                        "owned" | "write" | "write_scoped" => "owned",
                        "coordination_required" => "coordination_required",
                        _ => return None,
                    };
                    if mode.is_some_and(|previous| previous != normalized) {
                        return None;
                    }
                    mode = Some(normalized);
                }
            }
            let mut read_only = None;
            for key in ["readOnly", "read_only"] {
                if let Some(value) = map.get(key) {
                    let value = parse_runtime_bool(value)?;
                    if read_only.is_some_and(|previous| previous != value) {
                        return None;
                    }
                    read_only = Some(value);
                }
            }
            if read_only == Some(true) && mode.is_some_and(|mode| mode != "read_only")
                || read_only == Some(false) && mode == Some("read_only")
            {
                return None;
            }
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
                    owned_paths.extend(collect_scope_path_list(value, normalize_write_scope_path)?);
                }
            }
            owned_paths = unique_paths(owned_paths)?;

            let mut read_only_paths = Vec::new();
            for key in ["readOnlyPaths", "read_only_paths"] {
                if let Some(value) = map.get(key) {
                    read_only_paths.extend(collect_scope_path_list(
                        value,
                        normalize_read_only_scope_path,
                    )?);
                }
            }
            read_only_paths = unique_paths(read_only_paths)?;

            if mode == Some("read_only") || read_only == Some(true) {
                let mut assignment = AgentWriteScopeAssignment::read_only(rationale);
                assignment.read_only_paths = read_only_paths;
                assignment.source = "metadata".to_string();
                return Some(assignment);
            }

            if mode == Some("coordination_required") {
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

fn collect_scope_path_list(
    value: &JsonValue,
    normalize: fn(&str) -> Option<String>,
) -> Option<Vec<String>> {
    match value {
        JsonValue::String(raw) => Some(vec![normalize(raw)?]),
        JsonValue::Array(items) => unique_paths(
            items
                .iter()
                .map(|item| normalize(item.as_str()?))
                .collect::<Option<Vec<_>>>()?,
        ),
        _ => None,
    }
}

fn normalize_write_scope_path(raw: &str) -> Option<String> {
    let value = normalize_scope_path(raw)?;
    if value.starts_with('/') {
        return None;
    }
    Some(value)
}

fn normalize_read_only_scope_path(raw: &str) -> Option<String> {
    let value = normalize_scope_path(raw)?;
    if value.starts_with("/tmp/")
        || value.starts_with("/var/folders/")
        || value.starts_with("/workspace/")
        || value.starts_with("/workspaces/")
    {
        return Some(value);
    }

    (!value.starts_with('/')).then_some(value)
}

fn normalize_scope_path(raw: &str) -> Option<String> {
    let mut value = raw.trim().replace('\\', "/");
    // These are structured paths, not prose. Reject spellings that the runtime
    // would trim into a different path rather than guessing the caller's intent.
    let trimmed = value
        .trim_matches(|ch: char| {
            matches!(
                ch,
                ',' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}'
            )
        })
        .trim_end_matches('.');
    if trimmed != value {
        return None;
    }
    while value.starts_with("./") {
        value.drain(..2);
    }
    while value.contains("//") {
        value = value.replace("//", "/");
    }
    if value.is_empty()
        || value.starts_with('@')
        || value.contains(':')
        || value.contains("..")
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return None;
    }
    Some(value)
}

fn unique_paths(paths: Vec<String>) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if seen.insert(path.clone()) {
            out.push(path);
        }
        if out.len() > 12 {
            return None;
        }
    }
    Some(out)
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

        assert_eq!(
            plan["alpha"].mode,
            AgentWriteScopeMode::CoordinationRequired
        );
        assert!(plan["alpha"].owned_paths.is_empty());
    }

    fn scope_plan(metadata: JsonValue) -> AgentWriteScopeAssignment {
        build_agent_write_scope_plan(
            &metadata,
            "The prose must not supply or repair an explicit path scope.",
            &["alpha".to_string()],
            &HashMap::new(),
        )
        .remove("alpha")
        .expect("scope assignment")
    }

    fn assert_invalid_scope(metadata: JsonValue) {
        let scope = scope_plan(metadata);
        assert_eq!(scope.mode, AgentWriteScopeMode::CoordinationRequired);
        assert!(scope.owned_paths.is_empty());
        assert!(scope.read_only_paths.is_empty());
        assert_eq!(scope.source, "metadata");
        assert_eq!(scope.conflict.unwrap().reason, "invalid_write_scope");
    }

    #[test]
    fn preserves_structured_filenames_without_extension_guesses() {
        let scope = scope_plan(json!({
            "writeIntent": true,
            "agentSelection": {"writeScopes": {"alpha": {
                "ownedPaths": ["result.txt", "LICENSE", "data.custom-extension", ".gitignore"],
                "readOnlyPaths": ["input.txt", "Makefile", "fixtures/"]
            }}}
        }));
        assert_eq!(scope.mode, AgentWriteScopeMode::Owned);
        assert_eq!(
            scope.owned_paths,
            [
                "result.txt",
                "LICENSE",
                "data.custom-extension",
                ".gitignore"
            ]
        );
        assert_eq!(
            scope.read_only_paths,
            ["input.txt", "Makefile", "fixtures/"]
        );
    }

    #[test]
    fn preserves_explicit_path_forms_and_supported_globs() {
        for value in [
            json!("result.txt"),
            json!(["result.txt"]),
            json!({"paths": "result.txt"}),
        ] {
            assert_eq!(
                scope_plan(json!({"writeScope": value})).owned_paths,
                ["result.txt"]
            );
        }
        let scope = scope_plan(json!({"writeScope": {
            "mode": "write-scoped",
            "ownedPathGlobs": ["src/**", "assets/*.png"],
            "readOnlyPaths": ["./fixtures/", "test\\input.txt", "/tmp/runtime-local/", "/var/folders/test/source/", "/workspace/project/", "/workspaces/project/"]
        }}));
        assert_eq!(scope.mode, AgentWriteScopeMode::Owned);
        assert_eq!(scope.owned_paths, ["src/**", "assets/*.png"]);
        assert_eq!(
            scope.read_only_paths,
            [
                "fixtures/",
                "test/input.txt",
                "/tmp/runtime-local/",
                "/var/folders/test/source/",
                "/workspace/project/",
                "/workspaces/project/"
            ]
        );
    }

    #[test]
    fn validates_all_explicit_path_entries_and_types() {
        for value in [
            json!(null),
            json!(true),
            json!(42),
            json!(""),
            json!([]),
            json!({}),
            json!(["result.txt", "../escape.txt"]),
            json!(["result.txt", false]),
            json!({"ownedPaths": null}),
            json!({"ownedPaths": {"path": "result.txt"}}),
            json!({"ownedPaths": ["result.txt"], "readOnlyPaths": ["input.txt", 3]}),
            json!({"ownedPaths": ["result.txt"], "owned_paths": ["../escape"]}),
            json!({"ownedPaths": ["result.txt"], "read_only_paths": null}),
            json!({"mode": 1, "ownedPaths": ["result.txt"]}),
            json!({"mode": "unknown", "ownedPaths": ["result.txt"]}),
            json!({"mode": "owned", "status": "read_only", "ownedPaths": ["result.txt"]}),
            json!({"readOnly": "not-a-boolean", "ownedPaths": ["result.txt"]}),
            json!({"readOnly": true, "read_only": false}),
        ] {
            assert_invalid_scope(json!({"writeIntent": true, "writeScope": value}));
        }
    }

    #[test]
    fn invalid_explicit_scopes_cannot_fall_back_to_another_scope_or_unscoped() {
        for value in [
            json!(null),
            json!([]),
            json!({"alpha": null}),
            json!({"@Alpha": ["../escape"]}),
        ] {
            assert_invalid_scope(json!({
                "writeIntent": true,
                "agentSelection": {"writeScopes": value},
                "writeScope": {"ownedPaths": ["fallback.txt"]}
            }));
        }
        assert_eq!(
            scope_plan(json!({"writeIntent": true})).mode,
            AgentWriteScopeMode::Unscoped
        );
    }

    #[test]
    fn scope_aliases_retain_valid_paths_and_fail_closed_on_invalid_or_conflicting_values() {
        for key in [
            "agentWriteScopes",
            "agent_write_scopes",
            "writeScopes",
            "write_scopes",
        ] {
            assert_eq!(
                scope_plan(json!({key: {"@Alpha": ["result.txt"]}})).owned_paths,
                ["result.txt"]
            );
            assert_invalid_scope(json!({key: {"@Alpha": ["result.txt", null]}}));
        }
        for key in ["writeScopes", "write_scopes"] {
            assert_eq!(
                scope_plan(json!({"agentSelection": {key: {"alpha": ["result.txt"]}}})).owned_paths,
                ["result.txt"]
            );
            assert_invalid_scope(json!({"agentSelection": {key: {"alpha": ["result.txt", null]}}}));
        }
        for key in ["writeScope", "write_scope"] {
            assert_eq!(
                scope_plan(
                    json!({key: {"owned_paths": ["result.txt"], "read_only_paths": ["input.txt"]}})
                )
                .read_only_paths,
                ["input.txt"]
            );
            assert_invalid_scope(json!({key: false}));
        }
        assert_invalid_scope(
            json!({"writeScopes": {"alpha": ["result.txt"], "@Alpha": ["different.txt"]}}),
        );
        assert_invalid_scope(
            json!({"writeScopes": {"alpha": ["result.txt"]}, "write_scopes": {"alpha": false}}),
        );
        assert_invalid_scope(
            json!({"writeScope": ["result.txt"], "write_scope": ["different.txt"]}),
        );
    }

    #[test]
    fn rejects_excess_scope_paths_instead_of_truncating_claims() {
        let paths: Vec<_> = (0..13).map(|i| format!("file-{i}.txt")).collect();
        assert_eq!(
            scope_plan(json!({"writeScope": &paths[..12]}))
                .owned_paths
                .len(),
            12
        );
        assert_invalid_scope(json!({"writeScope": paths}));
        assert_invalid_scope(json!({"writeScope": {"mode": "read_only", "readOnlyPaths": paths}}));
        assert_invalid_scope(
            json!({"writeScope": {"ownedPaths": &paths[..7], "owned_paths": &paths[7..]}}),
        );
        let mut repeated = vec!["result.txt"; 13];
        assert_eq!(
            scope_plan(json!({"writeScope": repeated})).owned_paths,
            ["result.txt"]
        );
        repeated.push("../escape");
        assert_invalid_scope(json!({"writeScope": repeated}));
    }

    #[test]
    fn rejects_unsafe_or_reinterpreted_paths_in_owned_and_read_only_claims() {
        for path in [
            "../outside",
            "src/../../outside",
            "file..txt",
            "C:\\outside.txt",
            "C:outside.txt",
            "https://example.test/file.txt",
            "file\0.txt",
            "file\n.txt",
            "has space.txt",
            "result.txt.",
            "(result.txt)",
            "result.txt!",
            ".",
            "./",
        ] {
            assert_invalid_scope(json!({"writeScope": {"ownedPaths": [path]}}));
            assert_invalid_scope(
                json!({"writeScope": {"mode": "read_only", "readOnlyPaths": [path]}}),
            );
        }
        for path in [
            "/tmp/../secret",
            "/workspace/project/../../secret",
            "/var/folders/test/\0",
            "/workspaces/project/has space",
            "/etc/passwd",
        ] {
            assert_invalid_scope(
                json!({"writeScope": {"mode": "read_only", "readOnlyPaths": [path]}}),
            );
        }
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
