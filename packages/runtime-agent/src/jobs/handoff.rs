use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map as JsonMap, Value as JsonValue};

use super::{
    CodexAction, CodexFileDescriptor, MISSING_FINAL_RECOVERY_SNAPSHOT_MAX_BYTES,
    push_recovery_snapshot_line, recovery_relative_path, sorted_child_names,
};

pub(super) fn filter_read_only_coordination_files(
    files: Vec<CodexFileDescriptor>,
    allow_coordination_files: bool,
    handoff_claims: &[String],
) -> Vec<CodexFileDescriptor> {
    if !allow_coordination_files || handoff_claims.is_empty() {
        return Vec::new();
    }

    files
        .into_iter()
        .filter(|file| {
            workspace_path_matches_handoff_claim(&file.workspace_path, handoff_claims)
                || workspace_path_matches_handoff_claim(&file.path, handoff_claims)
        })
        .collect()
}

pub(super) fn declared_handoff_path_claims(actions: &[CodexAction]) -> Vec<String> {
    let mut claims = Vec::new();
    let mut seen = HashSet::new();
    for action in actions {
        let CodexAction::MultiAgentPlan { plan, .. } = action else {
            continue;
        };
        let Some(map) = plan.as_object() else {
            continue;
        };
        for raw in plan_handoff_path_strings(map) {
            let Some(normalized) = normalize_handoff_claim_path(raw.as_str()) else {
                continue;
            };
            if seen.insert(normalized.clone()) {
                claims.push(normalized);
            }
        }
    }
    claims
}

pub(super) fn plan_handoff_path_strings(map: &JsonMap<String, JsonValue>) -> Vec<String> {
    let mut out = Vec::new();
    for key in [
        "handoffPaths",
        "handoff_paths",
        "handoffPathGlobs",
        "handoff_path_globs",
        "temporaryPaths",
        "temporary_paths",
        "preparedPaths",
        "prepared_paths",
    ] {
        collect_json_string_values(map.get(key), &mut out);
    }
    out
}

fn collect_json_string_values(value: Option<&JsonValue>, out: &mut Vec<String>) {
    match value {
        Some(JsonValue::String(raw)) => {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
        Some(JsonValue::Array(entries)) => {
            for entry in entries {
                collect_json_string_values(Some(entry), out);
            }
        }
        _ => {}
    }
}

pub(super) fn normalize_handoff_claim_path(raw_path: &str) -> Option<String> {
    let trimmed = raw_path
        .trim()
        .trim_matches('`')
        .trim_start_matches("./")
        .trim();
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return None;
    }
    let wildcard_suffix = if let Some(prefix) = trimmed.strip_suffix("/**") {
        Some(("/**", prefix))
    } else if let Some(prefix) = trimmed.strip_suffix("/*") {
        Some(("/*", prefix))
    } else {
        None
    };
    let path_part = wildcard_suffix.map(|(_, prefix)| prefix).unwrap_or(trimmed);
    let path = sanitize_relative_handoff_path(path_part)?;
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    Some(match wildcard_suffix {
        Some((suffix, _)) => format!("{normalized}{suffix}"),
        None => normalized,
    })
}

fn workspace_path_matches_handoff_claim(raw_path: &str, claims: &[String]) -> bool {
    let Some(path) = normalize_handoff_workspace_path(raw_path) else {
        return false;
    };
    claims
        .iter()
        .any(|claim| handoff_claim_matches_path(claim, path.as_str()))
}

fn normalize_handoff_workspace_path(raw_path: &str) -> Option<String> {
    let trimmed = raw_path.trim().trim_matches('`').trim_start_matches("./");
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return None;
    }
    let path = sanitize_relative_handoff_path(trimmed)?;
    let normalized = path.to_string_lossy().replace('\\', "/");
    (!normalized.is_empty()).then_some(normalized)
}

fn sanitize_relative_handoff_path(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut buf = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(segment) => buf.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    if buf.as_os_str().is_empty() {
        None
    } else {
        Some(buf)
    }
}

fn handoff_claim_matches_path(claim: &str, path: &str) -> bool {
    if let Some(prefix) = claim.strip_suffix("/**") {
        return path == prefix || path.starts_with(&format!("{prefix}/"));
    }
    if let Some(prefix) = claim.strip_suffix("/*") {
        let Some(rest) = path.strip_prefix(&format!("{prefix}/")) else {
            return false;
        };
        return !rest.is_empty() && !rest.contains('/');
    }
    path == claim
}

pub(super) fn visible_shared_handoff_paths(
    workspace_dir: &Path,
    prompt_text: Option<&str>,
) -> Vec<(String, Vec<String>)> {
    let mut paths = Vec::new();
    for child in shared_path_roots(workspace_dir, prompt_text) {
        let rel = recovery_relative_path(workspace_dir, &child);
        let entries = if child.is_dir() {
            sorted_child_names(&child).into_iter().take(16).collect()
        } else {
            Vec::new()
        };
        paths.push((rel, entries));
    }
    paths
}

pub(super) fn has_visible_shared_handoff_path(
    workspace_dir: &Path,
    prompt_text: Option<&str>,
) -> bool {
    !shared_path_roots(workspace_dir, prompt_text).is_empty()
}

pub(super) fn push_visible_shared_path_details(
    out: &mut String,
    workspace_dir: &Path,
    prompt_text: Option<&str>,
) {
    let roots = shared_path_roots(workspace_dir, prompt_text);
    if roots.is_empty() {
        return;
    }

    push_recovery_snapshot_line(out, "\nVisible shared path details:");
    for root in roots.into_iter().take(6) {
        if out.len() >= MISSING_FINAL_RECOVERY_SNAPSHOT_MAX_BYTES {
            return;
        }
        let rel = recovery_relative_path(workspace_dir, &root);
        push_recovery_snapshot_line(out, &format!("- {rel}"));

        let tree_entries = tree_entries(&root, 3, 48);
        if !tree_entries.is_empty() {
            push_recovery_snapshot_line(out, "  tree:");
            for entry in tree_entries {
                push_recovery_snapshot_line(out, &format!("    {entry}"));
            }
        }

        for manifest in manifest_files(&root, 4, 8) {
            if out.len() >= MISSING_FINAL_RECOVERY_SNAPSHOT_MAX_BYTES {
                return;
            }
            let Ok(raw) = fs::read_to_string(&manifest) else {
                continue;
            };
            let snippet = raw.chars().take(700).collect::<String>();
            let manifest_rel = recovery_relative_path(workspace_dir, &manifest);
            push_recovery_snapshot_line(out, &format!("\n--- {manifest_rel} ---"));
            push_recovery_snapshot_line(out, snippet.trim());
        }
    }
}

fn shared_path_roots(workspace_dir: &Path, prompt_text: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    let prompt_markers = prompt_text.map(prompt_marker_tokens).unwrap_or_default();

    if let Some(prompt_text) = prompt_text {
        for candidate in prompt_visible_path_roots(workspace_dir, prompt_text) {
            push_unique_root(&mut roots, &mut seen, candidate);
        }
    }

    for parent_name in ["sources", "handoff"] {
        let parent = workspace_dir.join(parent_name);
        let Ok(entries) = fs::read_dir(parent) else {
            continue;
        };
        let mut children = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        children.sort();
        for child in children {
            if !prompt_markers.is_empty() {
                let rel = recovery_relative_path(workspace_dir, &child);
                if !prompt_markers
                    .iter()
                    .any(|marker| rel.contains(marker.as_str()))
                {
                    continue;
                }
            }
            push_unique_root(&mut roots, &mut seen, child);
        }
    }

    roots
}

fn push_unique_root(roots: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if !path.exists() {
        return;
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    if seen.insert(canonical.clone()) {
        roots.push(path);
    }
}

fn prompt_visible_path_roots(workspace_dir: &Path, prompt_text: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for candidate in prompt_workspace_path_candidates(prompt_text) {
        let Some(root) = prompt_candidate_existing_root(workspace_dir, candidate.as_str()) else {
            continue;
        };
        push_unique_root(&mut roots, &mut seen, root);
    }
    roots.sort();
    roots
}

fn prompt_workspace_path_candidates(prompt_text: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for (index, part) in prompt_text.split('`').enumerate() {
        if index % 2 == 1 {
            push_prompt_path_candidate(&mut candidates, &mut seen, part);
        }
    }
    for raw in prompt_text.split_whitespace() {
        if raw.contains('/') {
            push_prompt_path_candidate(&mut candidates, &mut seen, raw);
        }
    }
    candidates
}

fn push_prompt_path_candidate(candidates: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    let trimmed = raw.trim_matches(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                ',' | ';' | ':' | '.' | '!' | '?' | ')' | '(' | '[' | ']' | '{' | '}' | '"' | '\''
            )
    });
    if !trimmed.contains('/') {
        return;
    }
    if let Some(normalized) = normalize_handoff_claim_path(trimmed) {
        let root = normalized
            .strip_suffix("/**")
            .or_else(|| normalized.strip_suffix("/*"))
            .unwrap_or(normalized.as_str())
            .to_string();
        if seen.insert(root.clone()) {
            candidates.push(root);
        }
    }
}

fn prompt_candidate_existing_root(workspace_dir: &Path, candidate: &str) -> Option<PathBuf> {
    let rel = sanitize_relative_handoff_path(candidate)?;
    if path_has_hidden_component(&rel) {
        return None;
    }
    let path = workspace_dir.join(rel);
    if path.is_dir() {
        return Some(path);
    }
    if path.is_file() {
        return path.parent().map(Path::to_path_buf);
    }
    None
}

fn path_has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(segment) if segment.to_string_lossy().starts_with('.'))
    })
}

fn prompt_marker_tokens(prompt_text: &str) -> Vec<String> {
    let mut markers = Vec::new();
    let mut seen = HashSet::new();
    let mut current = String::new();
    for ch in prompt_text.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            current.push(ch.to_ascii_lowercase());
            continue;
        }

        push_prompt_marker_token(&mut markers, &mut seen, current.as_str());
        current.clear();
    }
    markers
}

fn push_prompt_marker_token(markers: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    let trimmed = raw.trim_matches(|ch| ch == '-' || ch == '_');
    if trimmed.len() < 8 || !trimmed.chars().any(|ch| ch.is_ascii_digit()) {
        return;
    }
    if looks_like_version_or_dimension(trimmed) {
        return;
    }
    if seen.insert(trimmed.to_string()) {
        markers.push(trimmed.to_string());
    }
}

fn looks_like_version_or_dimension(value: &str) -> bool {
    value.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
}

fn tree_entries(root: &Path, max_depth: usize, max_entries: usize) -> Vec<String> {
    let mut entries = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if entries.len() >= max_entries {
            break;
        }
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children = read_dir
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| !should_skip_entry(name))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        children.sort();
        for child in children {
            if entries.len() >= max_entries {
                break;
            }
            let relative = child
                .strip_prefix(root)
                .ok()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| child.display().to_string());
            if child.is_dir() {
                entries.push(format!("{relative}/"));
                if depth < max_depth {
                    queue.push_back((child, depth + 1));
                }
            } else {
                entries.push(relative);
            }
        }
    }
    entries
}

fn manifest_files(root: &Path, max_depth: usize, max_files: usize) -> Vec<PathBuf> {
    let mut manifests = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if manifests.len() >= max_files {
            break;
        }
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children = read_dir
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| !should_skip_entry(name))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        children.sort();
        for child in children {
            if manifests.len() >= max_files {
                break;
            }
            if child.is_dir() {
                if depth < max_depth {
                    queue.push_back((child, depth + 1));
                }
                continue;
            }

            let Some(name) = child.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if matches!(
                name,
                "package.json"
                    | "pnpm-workspace.yaml"
                    | "Cargo.toml"
                    | "pyproject.toml"
                    | "go.mod"
                    | "README.md"
            ) {
                manifests.push(child);
            }
        }
    }
    manifests
}

fn should_skip_entry(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | ".next" | "coverage" | "tmp"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn marker_specific_prompt_omits_stale_prepared_roots() {
        let tmp = tempdir().expect("temp dir");
        fs::create_dir_all(tmp.path().join("sources").join("borsh-ts"))
            .expect("create stale source");
        fs::create_dir_all(
            tmp.path()
                .join("sources")
                .join("matrix-borsh-public-20260608b")
                .join("borsh-ts"),
        )
        .expect("create marker source");

        let roots = visible_shared_handoff_paths(
            tmp.path(),
            Some("Review dao-xyz/borsh-ts for marker matrix-borsh-public-20260608b."),
        )
        .into_iter()
        .map(|(path, _)| path)
        .collect::<Vec<_>>();

        assert_eq!(roots, vec!["sources/matrix-borsh-public-20260608b"]);
    }

    #[test]
    fn unmarked_prompt_keeps_existing_prepared_roots_available() {
        let tmp = tempdir().expect("temp dir");
        fs::create_dir_all(tmp.path().join("sources").join("borsh-ts")).expect("create source");

        let roots = visible_shared_handoff_paths(
            tmp.path(),
            Some("Review dao-xyz/borsh-ts with multiple agents."),
        )
        .into_iter()
        .map(|(path, _)| path)
        .collect::<Vec<_>>();

        assert_eq!(roots, vec!["sources/borsh-ts"]);
    }
}
