use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::controller::LeaseJob;

use super::JobExecution;

pub const INSTAFY_FILENAME: &str = "INSTAFY.md";
pub const AGENTS_DOC_FILENAME: &str = "AGENTS.md";
pub const CLAUDE_DOC_FILENAME: &str = "CLAUDE.md";
pub const AGENTS_SCRIPT_FILENAME: &str = "AGENTS.py";
pub const SKILLS_ROOT_RELATIVE_PATH: &str = ".agents/skills";
pub const LEARNING_POLICY_RELATIVE_PATH: &str = ".agents/skills/instafy-learning-policy/SKILL.md";
pub const GIT_CANONICAL_RELATIVE_PATH: &str = ".agents/skills/instafy-git-canonical-sync/SKILL.md";
pub const GIT_CANONICAL_CONFLICTS_RELATIVE_PATH: &str =
    ".agents/skills/instafy-git-canonical-conflicts/SKILL.md";
pub const RUNTIME_FLAVORS_RELATIVE_PATH: &str = ".agents/skills/instafy-runtime-flavors/SKILL.md";
pub const SECRETS_RELATIVE_PATH: &str = ".agents/skills/instafy-secrets/SKILL.md";
pub const FRONTEND_PREVIEWS_RELATIVE_PATH: &str =
    ".agents/skills/instafy-frontend-previews/SKILL.md";
pub const INTEGRATION_ONBOARDING_RELATIVE_PATH: &str =
    ".agents/skills/instafy-integration-onboarding/SKILL.md";
pub const BYOC_AI_CREDENTIALS_RELATIVE_PATH: &str =
    ".agents/skills/instafy-byoc-ai-credentials/SKILL.md";
pub const COLLABORATION_RELATIVE_PATH: &str = ".agents/skills/instafy-collaboration/SKILL.md";
pub const AGENT_COLLABORATION_RELATIVE_PATH: &str =
    ".agents/skills/instafy-agent-collaboration/SKILL.md";
pub const GROUP_PARTICIPATION_RELATIVE_PATH: &str =
    ".agents/skills/instafy-group-participation/SKILL.md";
pub const CONVERSATION_HISTORY_RELATIVE_PATH: &str =
    ".agents/skills/instafy-conversation-history/SKILL.md";
pub const DIAGNOSTICS_RELATIVE_PATH: &str = ".agents/skills/instafy-diagnostics/SKILL.md";
pub const DIAGNOSTICS_OPENAI_RELATIVE_PATH: &str =
    ".agents/skills/instafy-diagnostics/agents/openai.yaml";
pub const LOCATION_SHARING_RELATIVE_PATH: &str = ".agents/skills/instafy-location-sharing/SKILL.md";
pub const AUTOMATIONS_RELATIVE_PATH: &str = ".agents/skills/instafy-automations/SKILL.md";
pub const PERSISTENT_CONTEXTS_RELATIVE_PATH: &str =
    ".agents/skills/instafy-persistent-contexts/SKILL.md";
pub const SKILL_ROUTER_RELATIVE_PATH: &str = ".agents/skills/instafy-skill-router/SKILL.md";
pub const SKILL_IMPORT_COMPAT_RELATIVE_PATH: &str =
    ".agents/skills/instafy-skill-import-compat/SKILL.md";
pub const BROWSER_AUTOMATION_RELATIVE_PATH: &str =
    ".agents/skills/instafy-browser-automation/SKILL.md";
pub const SKILL_READING_RELATIVE_PATH: &str = ".agents/skills/instafy-skill-reading/SKILL.md";
pub const LEARNED_INDEX_RELATIVE_PATH: &str = ".agents/skills/instafy-learned/SKILL.md";
pub const LEARNED_BLOCKS_DIR_RELATIVE_PATH: &str = ".agents/skills/instafy-learned/blocks";
pub const LEARNED_USAGE_RELATIVE_PATH: &str = ".agents/skills/instafy-learned/USAGE.json";

const DEFAULT_LOOKBACK: usize = 25;
const MAX_LOOKBACK: usize = 200;

// Hard limits enforced by the runtime (not only by model instructions) to keep
// workspace memory from ballooning and degrading subsequent runs.
const MAX_INSTAFY_MD_BYTES: usize = 10_000;
const MAX_LEARNED_INDEX_BYTES: usize = 6_000;
const MAX_LEARNED_INDEX_BLOCKS: usize = 20;
const MAX_LEARNED_USAGE_ENTRIES: usize = 500;
const USAGE_DEDUP_WINDOW_SECS: u64 = 6 * 60 * 60;

// Very simple "cold storage" thresholds; meant to be generic and safe. Higher-level logic
// (merge/dedupe, demote narrow blocks, etc.) stays model-driven. This is just downward pressure.
const COLD_BLOCK_UNUSED_TTL_SECS: u64 = 14 * 24 * 60 * 60;
const COLD_BLOCK_LOW_USE_TTL_SECS: u64 = 45 * 24 * 60 * 60;

const INSTAFY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/INSTAFY.md"
));
const AGENTS_DOC_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/AGENTS.md"
));
const CLAUDE_DOC_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/CLAUDE.md"
));
const AGENTS_SCRIPT_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/AGENTS.py"
));
const LEARNING_POLICY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-learning-policy/SKILL.md"
));
const GIT_CANONICAL_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-git-canonical-sync/SKILL.md"
));
const GIT_CANONICAL_CONFLICTS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-git-canonical-conflicts/SKILL.md"
));
const RUNTIME_FLAVORS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-runtime-flavors/SKILL.md"
));
const SECRETS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-secrets/SKILL.md"
));
const FRONTEND_PREVIEWS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-frontend-previews/SKILL.md"
));
const INTEGRATION_ONBOARDING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-integration-onboarding/SKILL.md"
));
const BYOC_AI_CREDENTIALS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-byoc-ai-credentials/SKILL.md"
));
const COLLABORATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-collaboration/SKILL.md"
));
const AGENT_COLLABORATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-agent-collaboration/SKILL.md"
));
const GROUP_PARTICIPATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-group-participation/SKILL.md"
));
/// This controller-owned workflow must remain available when the main prompt
/// deliberately omits ordinary workspace memory.
pub(super) fn group_participation_policy() -> &'static str {
    GROUP_PARTICIPATION_TEMPLATE
}

const CONVERSATION_HISTORY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-conversation-history/SKILL.md"
));
const DIAGNOSTICS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-diagnostics/SKILL.md"
));
const DIAGNOSTICS_OPENAI_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-diagnostics/agents/openai.yaml"
));
const LOCATION_SHARING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-location-sharing/SKILL.md"
));
const AUTOMATIONS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-automations/SKILL.md"
));
const PERSISTENT_CONTEXTS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-persistent-contexts/SKILL.md"
));
const SKILL_ROUTER_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-skill-router/SKILL.md"
));
const SKILL_IMPORT_COMPAT_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-skill-import-compat/SKILL.md"
));
const BROWSER_AUTOMATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-browser-automation/SKILL.md"
));
const SKILL_READING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-skill-reading/SKILL.md"
));
const LEARNED_INDEX_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/instafy/.agents/skills/instafy-learned/SKILL.md"
));

#[derive(Debug, Clone)]
pub struct LearnOptimizerResult {
    pub changed_paths: Vec<String>,
    pub instafy_bytes_before: usize,
    pub instafy_bytes_after: usize,
    pub learned_index_bytes_before: usize,
    pub learned_index_bytes_after: usize,
    pub blocks_total: usize,
    pub blocks_indexed: usize,
    pub usage_entries_before: usize,
    pub usage_entries_after: usize,
    pub usage_blocks_marked_used: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LearnedUsageFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    updated_at_ms: u64,
    #[serde(default)]
    blocks: BTreeMap<String, LearnedUsageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LearnedUsageEntry {
    #[serde(default)]
    uses: u32,
    #[serde(default)]
    first_seen_ms: u64,
    #[serde(default)]
    last_used_ms: Option<u64>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum LearnMode {
    Collect,
    Apply,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct LearnRequest {
    pub mode: LearnMode,
    pub lookback: usize,
}

pub fn ensure_project_memory_scaffold(workspace_dir: &Path) {
    let mut wrote_any = false;
    let instafy_path = workspace_dir.join(INSTAFY_FILENAME);
    let agents_doc_path = workspace_dir.join(AGENTS_DOC_FILENAME);
    let claude_doc_path = workspace_dir.join(CLAUDE_DOC_FILENAME);
    let agents_script_path = workspace_dir.join(AGENTS_SCRIPT_FILENAME);
    let skills_root_dir = workspace_dir.join(SKILLS_ROOT_RELATIVE_PATH);
    let policy_path = workspace_dir.join(LEARNING_POLICY_RELATIVE_PATH);
    let git_canonical_path = workspace_dir.join(GIT_CANONICAL_RELATIVE_PATH);
    let git_conflicts_path = workspace_dir.join(GIT_CANONICAL_CONFLICTS_RELATIVE_PATH);
    let runtime_flavors_path = workspace_dir.join(RUNTIME_FLAVORS_RELATIVE_PATH);
    let secrets_path = workspace_dir.join(SECRETS_RELATIVE_PATH);
    let frontend_previews_path = workspace_dir.join(FRONTEND_PREVIEWS_RELATIVE_PATH);
    let integration_onboarding_path = workspace_dir.join(INTEGRATION_ONBOARDING_RELATIVE_PATH);
    let byoc_ai_credentials_path = workspace_dir.join(BYOC_AI_CREDENTIALS_RELATIVE_PATH);
    let collaboration_path = workspace_dir.join(COLLABORATION_RELATIVE_PATH);
    let agent_collaboration_path = workspace_dir.join(AGENT_COLLABORATION_RELATIVE_PATH);
    let group_participation_path = workspace_dir.join(GROUP_PARTICIPATION_RELATIVE_PATH);
    let conversation_history_path = workspace_dir.join(CONVERSATION_HISTORY_RELATIVE_PATH);
    let diagnostics_path = workspace_dir.join(DIAGNOSTICS_RELATIVE_PATH);
    let diagnostics_openai_path = workspace_dir.join(DIAGNOSTICS_OPENAI_RELATIVE_PATH);
    let location_sharing_path = workspace_dir.join(LOCATION_SHARING_RELATIVE_PATH);
    let automations_path = workspace_dir.join(AUTOMATIONS_RELATIVE_PATH);
    let persistent_contexts_path = workspace_dir.join(PERSISTENT_CONTEXTS_RELATIVE_PATH);
    let skill_router_path = workspace_dir.join(SKILL_ROUTER_RELATIVE_PATH);
    let skill_import_compat_path = workspace_dir.join(SKILL_IMPORT_COMPAT_RELATIVE_PATH);
    let browser_automation_path = workspace_dir.join(BROWSER_AUTOMATION_RELATIVE_PATH);
    let skill_reading_path = workspace_dir.join(SKILL_READING_RELATIVE_PATH);
    let learned_index_path = workspace_dir.join(LEARNED_INDEX_RELATIVE_PATH);
    let learned_blocks_dir_path = workspace_dir.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH);

    if fs::create_dir_all(&skills_root_dir).is_err() {
        return;
    }

    if !instafy_path.exists() {
        if fs::write(&instafy_path, INSTAFY_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !agents_doc_path.exists() {
        if fs::write(&agents_doc_path, AGENTS_DOC_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !claude_doc_path.exists() {
        if fs::write(&claude_doc_path, CLAUDE_DOC_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !agents_script_path.exists() {
        if fs::write(&agents_script_path, AGENTS_SCRIPT_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !policy_path.exists() {
        if let Some(parent) = policy_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&policy_path, LEARNING_POLICY_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !git_canonical_path.exists() {
        if let Some(parent) = git_canonical_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&git_canonical_path, GIT_CANONICAL_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !git_conflicts_path.exists() {
        if let Some(parent) = git_conflicts_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&git_conflicts_path, GIT_CANONICAL_CONFLICTS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !runtime_flavors_path.exists() {
        if let Some(parent) = runtime_flavors_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&runtime_flavors_path, RUNTIME_FLAVORS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !secrets_path.exists() {
        if let Some(parent) = secrets_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&secrets_path, SECRETS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !frontend_previews_path.exists() {
        if let Some(parent) = frontend_previews_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&frontend_previews_path, FRONTEND_PREVIEWS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !integration_onboarding_path.exists() {
        if let Some(parent) = integration_onboarding_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(
            &integration_onboarding_path,
            INTEGRATION_ONBOARDING_TEMPLATE,
        )
        .is_ok()
        {
            wrote_any = true;
        }
    }

    if !byoc_ai_credentials_path.exists() {
        if let Some(parent) = byoc_ai_credentials_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&byoc_ai_credentials_path, BYOC_AI_CREDENTIALS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = collaboration_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Keep built-in collaboration guidance current so new CLI capabilities (for example role
    // changes in addition to invites) are immediately available in existing pre-live workspaces.
    if fs::read_to_string(&collaboration_path).ok().as_deref() != Some(COLLABORATION_TEMPLATE) {
        if fs::write(&collaboration_path, COLLABORATION_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = agent_collaboration_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::read_to_string(&agent_collaboration_path)
        .ok()
        .as_deref()
        != Some(AGENT_COLLABORATION_TEMPLATE)
    {
        if fs::write(&agent_collaboration_path, AGENT_COLLABORATION_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = group_participation_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::read_to_string(&group_participation_path)
        .ok()
        .as_deref()
        != Some(GROUP_PARTICIPATION_TEMPLATE)
    {
        if fs::write(&group_participation_path, GROUP_PARTICIPATION_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = conversation_history_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::read_to_string(&conversation_history_path)
        .ok()
        .as_deref()
        != Some(CONVERSATION_HISTORY_TEMPLATE)
    {
        if fs::write(&conversation_history_path, CONVERSATION_HISTORY_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !diagnostics_path.exists() {
        if let Some(parent) = diagnostics_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&diagnostics_path, DIAGNOSTICS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !diagnostics_openai_path.exists() {
        if let Some(parent) = diagnostics_openai_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&diagnostics_openai_path, DIAGNOSTICS_OPENAI_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = location_sharing_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::read_to_string(&location_sharing_path).ok().as_deref() != Some(LOCATION_SHARING_TEMPLATE)
    {
        if fs::write(&location_sharing_path, LOCATION_SHARING_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !automations_path.exists() {
        if let Some(parent) = automations_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&automations_path, AUTOMATIONS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = persistent_contexts_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::read_to_string(&persistent_contexts_path)
        .ok()
        .as_deref()
        != Some(PERSISTENT_CONTEXTS_TEMPLATE)
    {
        if fs::write(&persistent_contexts_path, PERSISTENT_CONTEXTS_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if let Some(parent) = skill_router_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::read_to_string(&skill_router_path).ok().as_deref() != Some(SKILL_ROUTER_TEMPLATE) {
        if fs::write(&skill_router_path, SKILL_ROUTER_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !skill_import_compat_path.exists() {
        if let Some(parent) = skill_import_compat_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&skill_import_compat_path, SKILL_IMPORT_COMPAT_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !browser_automation_path.exists() {
        if let Some(parent) = browser_automation_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&browser_automation_path, BROWSER_AUTOMATION_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !skill_reading_path.exists() {
        if let Some(parent) = skill_reading_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&skill_reading_path, SKILL_READING_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if !learned_index_path.exists() {
        if let Some(parent) = learned_index_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&learned_index_path, LEARNED_INDEX_TEMPLATE).is_ok() {
            wrote_any = true;
        }
    }

    if fs::create_dir_all(&learned_blocks_dir_path).is_ok() {
        // Directory creation isn't meaningful "write" for git, but helps avoid races for /learn.
    }

    // Commit the scaffold whenever it's present but not recorded yet (e.g. untracked on seed repos),
    // not only when this call wrote the files.
    maybe_commit_project_memory_scaffold(workspace_dir, wrote_any);
}

pub fn parse_learn_request(prompt_text: &str) -> Option<LearnRequest> {
    let trimmed = prompt_text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("/learn") {
        return Some(parse_learn_command(trimmed));
    }

    // We intentionally do not auto-trigger learnings from natural-language heuristics.
    // Users should invoke `/learn` explicitly so this stays predictable.
    None
}

fn maybe_commit_project_memory_scaffold(workspace_dir: &Path, _wrote_any: bool) {
    let git_dir = workspace_dir.join(".instafy").join(".git");
    if !git_dir.exists() {
        return;
    }

    let has_head = git_has_head(workspace_dir);
    if has_head && !is_instafy_seed_repo(workspace_dir) {
        return;
    }

    ensure_git_identity(workspace_dir);

    let scaffold_paths = [
        INSTAFY_FILENAME,
        AGENTS_DOC_FILENAME,
        CLAUDE_DOC_FILENAME,
        AGENTS_SCRIPT_FILENAME,
        LEARNING_POLICY_RELATIVE_PATH,
        GIT_CANONICAL_RELATIVE_PATH,
        GIT_CANONICAL_CONFLICTS_RELATIVE_PATH,
        RUNTIME_FLAVORS_RELATIVE_PATH,
        SECRETS_RELATIVE_PATH,
        FRONTEND_PREVIEWS_RELATIVE_PATH,
        INTEGRATION_ONBOARDING_RELATIVE_PATH,
        BYOC_AI_CREDENTIALS_RELATIVE_PATH,
        COLLABORATION_RELATIVE_PATH,
        AGENT_COLLABORATION_RELATIVE_PATH,
        GROUP_PARTICIPATION_RELATIVE_PATH,
        CONVERSATION_HISTORY_RELATIVE_PATH,
        DIAGNOSTICS_RELATIVE_PATH,
        DIAGNOSTICS_OPENAI_RELATIVE_PATH,
        LOCATION_SHARING_RELATIVE_PATH,
        AUTOMATIONS_RELATIVE_PATH,
        PERSISTENT_CONTEXTS_RELATIVE_PATH,
        SKILL_ROUTER_RELATIVE_PATH,
        SKILL_IMPORT_COMPAT_RELATIVE_PATH,
        BROWSER_AUTOMATION_RELATIVE_PATH,
        SKILL_READING_RELATIVE_PATH,
        LEARNED_INDEX_RELATIVE_PATH,
    ];

    for path in scaffold_paths {
        if workspace_dir.join(path).exists() {
            let _ = run_git(workspace_dir, &["add", "-A", "--", path]);
        }
    }

    let staged = run_git(workspace_dir, &["diff", "--cached", "--name-only"])
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_default();
    if staged.trim().is_empty() {
        return;
    }

    let _ = run_git(
        workspace_dir,
        &[
            "commit",
            "--no-gpg-sign",
            "-m",
            "instafy: bootstrap workspace memory",
        ],
    );
}

fn git_stdout_trimmed(workspace_dir: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(workspace_dir, args)?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.trim().to_string())
}

fn is_instafy_seed_repo(workspace_dir: &Path) -> bool {
    let subject = git_stdout_trimmed(workspace_dir, &["log", "-1", "--pretty=%s"]);
    let author_email = git_stdout_trimmed(workspace_dir, &["log", "-1", "--pretty=%ae"]);
    let commit_count = git_stdout_trimmed(workspace_dir, &["rev-list", "--count", "HEAD"]);

    matches!(
        (
            subject.as_deref(),
            author_email.as_deref(),
            commit_count.as_deref()
        ),
        (
            Some("instafy: init"),
            Some("service-runtime@instafy.dev"),
            Some("1")
        )
    )
}

fn git_has_head(workspace_dir: &Path) -> bool {
    run_git(workspace_dir, &["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn ensure_git_identity(workspace_dir: &Path) {
    let existing_name = run_git(workspace_dir, &["config", "--get", "user.name"])
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_default();
    if existing_name.trim().is_empty() {
        let _ = run_git(workspace_dir, &["config", "user.name", "Instafy Studio"]);
    }

    let existing_email = run_git(workspace_dir, &["config", "--get", "user.email"])
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_default();
    if existing_email.trim().is_empty() {
        let _ = run_git(
            workspace_dir,
            &["config", "user.email", "studio@instafy.dev"],
        );
    }
}

fn run_git(workspace_dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    Command::new("git")
        .current_dir(workspace_dir)
        .arg("--git-dir")
        .arg(workspace_dir.join(".instafy").join(".git"))
        .arg("--work-tree")
        .arg(workspace_dir)
        .args(args)
        .output()
        .ok()
}

fn parse_learn_command(prompt_text: &str) -> LearnRequest {
    let mut rest = prompt_text.trim()["/learn".len()..].trim();
    if let Some(stripped) = rest.strip_prefix(':') {
        rest = stripped.trim();
    }

    let mut mode = LearnMode::Apply;
    let mut lookback = DEFAULT_LOOKBACK;

    let mut tokens = rest.split_whitespace();
    if let Some(first) = tokens.next() {
        let lowered = first.trim().trim_end_matches(':').to_ascii_lowercase();
        match lowered.as_str() {
            "collect" => mode = LearnMode::Collect,
            "apply" => mode = LearnMode::Apply,
            _ => {
                if let Ok(value) = lowered.parse::<usize>() {
                    lookback = value;
                }
            }
        }

        if let Some(next) = tokens.next() {
            if let Ok(value) = next.trim().parse::<usize>() {
                lookback = value;
            }
        }
    }

    LearnRequest {
        mode,
        lookback: lookback.clamp(1, MAX_LOOKBACK),
    }
}

pub fn build_collect_execution(job: &LeaseJob, lookback: usize) -> JobExecution {
    let safe_lookback = lookback.clamp(1, MAX_LOOKBACK);
    let turns = super::conversation_context::parse_conversation_history(
        job.payload.get("conversation_history"),
    );
    let start = turns.len().saturating_sub(safe_lookback);
    let formatted = super::conversation_context::format_conversation_history(&turns[start..]);

    let project_id = job
        .project_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "<unknown>".to_string());
    let conversation_id = job
        .conversation_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "<unknown>".to_string());

    let summary = format!(
        "Learn scan (last {safe_lookback} turns)\n\
\n\
Space: {project_id}\n\
Conversation: {conversation_id}\n\
\n\
{formatted}\n\
\n\
        Tip: For full token usage + run metadata, use `instafy history` (or `instafy api get` as fallback) against the controller API.",
    );

    JobExecution {
        summary,
        suggested_replies: Vec::new(),
        provider: "learn-scan".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: Vec::new(),
    }
}

pub fn build_learn_ai_prompt(
    project_id: Uuid,
    conversation_id: Option<Uuid>,
    lookback: usize,
    agent_identity: Option<&str>,
    conversation_preview: &str,
) -> String {
    let safe_lookback = lookback.clamp(1, MAX_LOOKBACK);

    let conversation_hint = conversation_id.map(|id| format!("{id}"));

    let agent = agent_identity.unwrap_or("Instafy Agent");

    let mut cli_instructions = String::new();
    cli_instructions.push_str(
        "- The access token is already available in env (e.g. `CONTROLLER_ACCESS_TOKEN`).\n",
    );
    if let Some(conversation_id) = conversation_hint.as_deref() {
        cli_instructions.push_str("- Preferred commands:\n");
        cli_instructions.push_str(&format!(
            "  - `instafy history messages --conversation {conversation_id} --limit {safe_lookback}`\n"
        ));
        cli_instructions.push_str(&format!(
            "  - `instafy history runs --conversation {conversation_id} --limit 50`\n"
        ));
    } else {
        cli_instructions.push_str(&format!(
            "- Conversation id is missing; resolve it first:\n\
  - `instafy history conversations --space {project_id} --limit 10`\n"
        ));
    }

    format!(
        "You are running `/learn` for this space.\n\
\n\
Goal: update this workspace’s long-term memory (persistent context files / skills) based on the recent conversation.\n\
\n\
Must-do (in order):\n\
1) Load the memory snapshot:\n\
   - Always run `python AGENTS.py` if present before scanning files, and use its output as your primary memory snapshot.\n\
   - If the script is missing or fails, read `AGENTS.md`, `INSTAFY.md`, and `.agents/skills/*/SKILL.md` directly.\n\
\n\
2) If you need message metadata (token usage, run ids, tool traces), query the controller API using the Instafy CLI.\n\
{cli_instructions}\
\n\
3) Load the learning policy before shaping memory:\n\
   - Read `.agents/skills/instafy-learning-policy/SKILL.md` and treat it as the primary policy for what to learn, what not to learn, and what good memory should look like.\n\
   - If a pinned workflow skill exists for the task area, treat that pinned skill as the source of generic workflow behavior and only store task/space-specific delta in learned memory.\n\
   - Follow the policy skill instead of restating it here. In general: preserve exact worked cues, preserve retrieval cues over one-off answers, and avoid storing execution anxiety or replay chatter.\n\
   - When the policy skill gives a stronger exact cue than your draft memory, prefer the stronger cue.\n\
   - Before saving any learned block, self-audit it against the policy skill. If the draft still uses vague intent phrases such as \"visible control\", \"matching result\", \"containing X\", or \"apply the filter\" where the successful run had an exact worked cue, rewrite it before saving.\n\
   - When run traces or command JSON expose `workedCues`, treat those exact observed cues as higher-confidence than your own paraphrase and copy them into memory at the strongest useful level.\n\
   - For successful link-entry steps, prefer exact visible link text or a stable selector/href over substring phrases like \"containing X\" or \"matching X\".\n\
   - For search/result stages, a learned block is invalid if it only keeps the route/query/destination and drops the exact worked field cue, submit cue, or result-entry cue.\n\
   - For retrieval stages, do not store one observed sample value as memory or as a verify condition when the stable lesson is really the human-facing retrieval label and its mapping into the reply.\n\
   - If the task decomposes into separable reusable stages with different entry points, prefer separate compact learned blocks over one long combined replay.\n\
   - If the next run could plausibly start from an intermediate narrowed state, split the memory at that boundary instead of forcing one combined block.\n\
   - Treat \"narrow the state\" (search/filter/pagination/tab/menu/listing) -> \"enter final detail page and retrieve\" as a default split boundary unless the final entry is inseparable from the narrowing step.\n\
\n\
4) Apply safe edits:\n\
   - Update `INSTAFY.md` with stable, space-specific preferences/facts.\n\
   - Before editing memory files, measure their sizes so you can keep them small:\n\
     - `wc -c INSTAFY.md .agents/skills/instafy-learned/SKILL.md`\n\
   - Enforce hard budgets:\n\
     - `INSTAFY.md` <= ~10k bytes\n\
     - `.agents/skills/instafy-learned/SKILL.md` <= ~6k bytes and a short list (prefer <= 20 blocks)\n\
     If you need more detail, write it into a learned block (SKILL + optional DETAILS) and keep only a short pointer in the index.\n\
   - If the User expressed a stable preference about assistant language, write it as a plain sentence (not a config variable), exactly like:\n\
     - \"Users want AI agents to reply in <Language>\" (example: \"Users want AI agents to reply in German\")\n\
   - Prefer writing new learnings as small persistent context files (memory blocks) under:\n\
     - `.agents/skills/instafy-learned/blocks/<kebab-name>/SKILL.md`\n\
   - Keep each learned skill small. If you need extra detail, create a sibling file:\n\
     - `.agents/skills/instafy-learned/blocks/<kebab-name>/DETAILS.md`\n\
     and link to it from the SKILL.\n\
   - Update the learned index skill:\n\
     - `.agents/skills/instafy-learned/SKILL.md`\n\
     so it contains a short, skimmable list of learned blocks with Markdown links + a one-line \"apply when\" description.\n\
   - Only create or update top-level skills under `.agents/skills/<name>/SKILL.md` when it is truly always-on and space-wide.\n\
   - Attribute substantial new memory additions with \"Learned by: {agent}\".\n\
   - Never store secrets.\n\
\n\
Optimizer pass (downward pressure):\n\
- Merge near-duplicate learned blocks.\n\
- Demote narrow site/tool-specific rules unless they are high-frequency and clearly reduce retries/turns.\n\
- Promote repeated patterns into a general learned block.\n\
- Expire or prune stale/low-value blocks.\n\
- Enforce budgets:\n\
 - avoid long prose\n\
  - prefer short procedures + stop conditions\n\
 - If a candidate learning mostly expands into executable script, compress it into heuristics or skip it.\n\
 - If a candidate learning would likely increase shell/tool branching on the next run, rewrite it to be shorter and more decision-oriented.\n\
 - If the policy skill would reject the memory shape as vague, procedural, or over-combined, rewrite it or split it.\n\
 - Prefer smaller composable blocks when one long learned block would mix multiple reusable stages.\n\
 - For navigation + target-entry tasks, prefer one block that reaches the narrowed state and one block that completes the final entry/retrieval, unless they are inseparable.\n\
 - If a draft block includes both the narrowing cue and the final detail-page verify cue, treat that as over-combined by default and split it into a navigation block plus an entry/retrieval block.\n\
\n\
Conversation preview (may be incomplete):\n\
{conversation_preview}\n\
\n\
Output requirements:\n\
- Return the usual JSON object.\n\
- `summary` should be a short, user-facing outcome sentence.\n\
  - Do not add a redundant `Learn:` prefix (the UI already labels this thread).\n\
  - Mention `INSTAFY.md` (even if no updates were needed).\n\
"
    )
}

fn write_file_if_changed(path: &Path, content: &str) -> bool {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if existing == content {
        return false;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, content).is_ok()
}

fn bytes_to_best_effort_utf8(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| String::from_utf8_lossy(bytes).to_string())
}

fn normalize_newlines(text: &str) -> String {
    // Normalizing CRLF keeps diffs stable across runtimes and host OSes.
    text.replace("\r\n", "\n")
}

fn system_time_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    system_time_millis(SystemTime::now())
}

fn is_valid_block_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('.') || trimmed.starts_with('_') {
        return false;
    }
    trimmed
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn extract_used_learned_block_names(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    if text.trim().is_empty() {
        return out;
    }

    const PREFIXES: [&str; 2] = [".agents/skills/instafy-learned/blocks/", "blocks/"];

    for prefix in PREFIXES {
        let mut index = 0;
        while let Some(pos) = text[index..].find(prefix) {
            let start = index + pos + prefix.len();
            let rest = &text[start..];
            let mut name = String::new();
            for ch in rest.chars() {
                if ch == '/' {
                    break;
                }
                if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_' {
                    name.push(ch);
                    continue;
                }
                break;
            }
            if is_valid_block_name(name.as_str()) {
                out.insert(name);
            }
            index = start;
        }
    }

    out
}

fn load_learned_usage(path: &Path) -> LearnedUsageFile {
    let bytes = fs::read(path).unwrap_or_default();
    if bytes.is_empty() {
        return LearnedUsageFile {
            version: 1,
            updated_at_ms: 0,
            blocks: BTreeMap::new(),
        };
    }
    let parsed: LearnedUsageFile = serde_json::from_slice(&bytes).unwrap_or_default();
    LearnedUsageFile {
        version: if parsed.version == 0 {
            1
        } else {
            parsed.version
        },
        ..parsed
    }
}

fn write_learned_usage_if_changed(path: &Path, usage: &LearnedUsageFile) -> bool {
    let json = serde_json::to_string_pretty(usage).unwrap_or_else(|_| "{}".to_string());
    write_file_if_changed(path, normalize_newlines(json.as_str()).as_str())
}

fn list_existing_learned_skill_blocks(workspace_dir: &Path) -> HashSet<String> {
    let learned_blocks_dir = workspace_dir.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH);
    let mut names = HashSet::new();
    if let Ok(entries) = fs::read_dir(&learned_blocks_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_valid_block_name(name.as_str()) {
                continue;
            }
            if !path.join("SKILL.md").is_file() {
                continue;
            }
            names.insert(name);
        }
    }
    names
}

fn cap_learned_usage_entries(usage: &mut LearnedUsageFile) {
    if usage.blocks.len() <= MAX_LEARNED_USAGE_ENTRIES {
        return;
    }

    // Keep the most recently used/seen entries; drop cold entries to keep this file small.
    let mut ranked: Vec<(String, u64)> = usage
        .blocks
        .iter()
        .map(|(name, entry)| {
            let key = entry.last_used_ms.unwrap_or(entry.first_seen_ms);
            (name.clone(), key)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(MAX_LEARNED_USAGE_ENTRIES);
    let keep: HashSet<String> = ranked.into_iter().map(|(name, _)| name).collect();
    usage.blocks.retain(|name, _| keep.contains(name));
}

fn update_learned_usage_from_conversation(
    workspace_dir: &Path,
    conversation_text: Option<&str>,
    changed_paths: &mut Vec<String>,
) -> (usize, usize, usize) {
    let usage_path = workspace_dir.join(LEARNED_USAGE_RELATIVE_PATH);
    let mut usage = load_learned_usage(&usage_path);
    let before = usage.blocks.len();

    let existing_blocks = list_existing_learned_skill_blocks(workspace_dir);
    usage
        .blocks
        .retain(|name, _| existing_blocks.contains(name));

    let mut marked_used = 0usize;
    if let Some(text) = conversation_text {
        let used = extract_used_learned_block_names(text);
        if !used.is_empty() {
            let now = now_millis();
            for name in used {
                if !existing_blocks.contains(&name) {
                    continue;
                }
                let entry = usage
                    .blocks
                    .entry(name)
                    .or_insert_with(|| LearnedUsageEntry {
                        uses: 0,
                        first_seen_ms: now,
                        last_used_ms: None,
                    });
                // Avoid inflating usage counts when /learn is invoked repeatedly in a short period.
                // We still update last_used_ms so the cold-demotion logic stays accurate.
                let should_bump = match entry.last_used_ms {
                    Some(last_used_ms) => {
                        now.saturating_sub(last_used_ms) > USAGE_DEDUP_WINDOW_SECS * 1000
                    }
                    None => true,
                };
                if should_bump {
                    entry.uses = entry.uses.saturating_add(1);
                }
                entry.last_used_ms = Some(now);
                marked_used += 1;
            }
        }
    }

    cap_learned_usage_entries(&mut usage);
    usage.updated_at_ms = now_millis();

    let after = usage.blocks.len();
    if write_learned_usage_if_changed(&usage_path, &usage) {
        changed_paths.push(LEARNED_USAGE_RELATIVE_PATH.to_string());
    }
    (before, after, marked_used)
}

fn split_at_newline_boundary(bytes: &[u8], max_bytes: usize) -> (Vec<u8>, Vec<u8>) {
    if bytes.len() <= max_bytes {
        return (bytes.to_vec(), Vec::new());
    }
    let cutoff = max_bytes.min(bytes.len());
    let mut cut = cutoff;
    // Find a safe newline boundary within the prefix.
    if let Some(pos) = bytes[..cutoff].iter().rposition(|b| *b == b'\n') {
        cut = pos + 1;
    }
    (bytes[..cut].to_vec(), bytes[cut..].to_vec())
}

fn optimize_instafy_md(workspace_dir: &Path, changed_paths: &mut Vec<String>) -> (usize, usize) {
    let instafy_path = workspace_dir.join(INSTAFY_FILENAME);
    let bytes = fs::read(&instafy_path).unwrap_or_default();
    let before = bytes.len();
    if before <= MAX_INSTAFY_MD_BYTES || bytes.is_empty() {
        return (before, before);
    }

    let (prefix, overflow) = split_at_newline_boundary(&bytes, MAX_INSTAFY_MD_BYTES);
    let overflow_text = bytes_to_best_effort_utf8(&overflow);

    let overflow_block_dir = workspace_dir
        .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
        .join("instafy-memory-overflow");
    let overflow_details_path = overflow_block_dir.join("DETAILS.md");

    let overflow_details = normalize_newlines(&format!(
        "# INSTAFY.md overflow\n\
\n\
This file is generated by the runtime `/learn` optimizer when `{}` grows too large.\n\
\n\
## Why this exists\n\
\n\
Keeping `{}` tiny reduces prompt bloat and makes future runs faster and more reliable.\n\
\n\
## Overflow content\n\
\n\
{}\n",
        INSTAFY_FILENAME,
        INSTAFY_FILENAME,
        overflow_text.trim()
    ));

    if write_file_if_changed(&overflow_details_path, overflow_details.as_str()) {
        if let Ok(relative) = overflow_details_path.strip_prefix(workspace_dir) {
            changed_paths.push(relative.to_string_lossy().to_string());
        }
    }

    let mut new_instafy = bytes_to_best_effort_utf8(&prefix);
    new_instafy = normalize_newlines(new_instafy.trim_end());
    new_instafy.push_str("\n\n---\n\n");
    new_instafy.push_str(&format!(
        "[Truncated by `/learn` optimizer: `{}` exceeded {} bytes. Overflow moved to `{}`.]\n",
        INSTAFY_FILENAME,
        MAX_INSTAFY_MD_BYTES,
        overflow_details_path
            .strip_prefix(workspace_dir)
            .map(|p| p.to_string_lossy())
            .unwrap_or_else(|_| overflow_details_path.to_string_lossy())
    ));

    let after = new_instafy.as_bytes().len();
    if write_file_if_changed(&instafy_path, new_instafy.as_str()) {
        changed_paths.push(INSTAFY_FILENAME.to_string());
    }

    (before, after)
}

fn parse_front_matter_description(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let mut lines = trimmed.lines();
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    for line in lines.by_ref() {
        let raw = line.trim();
        if raw == "---" {
            break;
        }
        if let Some(rest) = raw.strip_prefix("description:") {
            let value = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn describe_block(block_skill_path: &Path) -> String {
    let bytes = fs::read(block_skill_path).unwrap_or_default();
    let preview = bytes_to_best_effort_utf8(&bytes[..bytes.len().min(4096)]);
    if let Some(desc) = parse_front_matter_description(preview.as_str()) {
        return desc;
    }

    // Fallback: first non-empty line after the first markdown heading.
    let mut saw_heading = false;
    for line in preview.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            saw_heading = true;
            continue;
        }
        if saw_heading {
            return trimmed.to_string();
        }
    }
    "Learned block (no description)".to_string()
}

fn learned_block_quality_flags(text: &str) -> Vec<&'static str> {
    let mut flags = Vec::new();
    let size_bytes = text.as_bytes().len();
    let lower = text.to_ascii_lowercase();
    let bullet_count = text
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ") || trimmed.starts_with("* ")
        })
        .count();

    if size_bytes > 1_800 {
        flags.push("large_block");
    }
    if bullet_count > 8 {
        flags.push("too_many_bullets");
    }
    if text.contains("```") {
        flags.push("code_fence");
    }
    let contains_command_snippet = [
        "bash -lc",
        "sh -lc",
        "node - <<",
        "python - <<",
        "npm root -g",
        "instafy history",
        "instafy api",
    ]
    .iter()
    .any(|needle| text.contains(needle));
    let contains_inline_command_instruction = [
        "run exactly `",
        "execute exactly `",
        "copy this command:",
        "paste this command:",
        "use this exact command:",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if contains_command_snippet || contains_inline_command_instruction {
        flags.push("workflow_execution_replay");
    }
    if [
        "apply when: any ",
        "apply when\n- any ",
        "vaguely similar",
        "any memory question",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        flags.push("vague_apply_when");
    }
    if [
        "verify vaguely",
        "stop eventually",
        "consider many possible options",
        "continue considering options",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        flags.push("vague_placeholder_guidance");
    }
    if !text.lines().any(|line| {
        line.trim_start().starts_with("## Verify")
            || line.trim_start().starts_with("# Verify")
            || line.to_ascii_lowercase().contains("stop/verify")
    }) {
        flags.push("missing_verify_section");
    }
    if [
        "produced token `",
        "returned token `",
        "example produced token `",
        "learned example produced token `",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        flags.push("stores_example_output_value");
    }

    flags
}

fn learned_block_quality_penalty(text: &str) -> u128 {
    let flags = learned_block_quality_flags(text);
    if flags.is_empty() {
        return 0;
    }

    let mut penalty = 0u128;
    for flag in flags {
        penalty += match flag {
            "workflow_execution_replay" => 4,
            "stores_example_output_value" => 4,
            "vague_apply_when" => 2,
            "vague_placeholder_guidance" => 2,
            "code_fence" => 3,
            "missing_verify_section" => 2,
            "large_block" => 2,
            "too_many_bullets" => 1,
            _ => 1,
        };
    }
    penalty
}

fn system_time_sort_key(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn optimize_learned_index(
    workspace_dir: &Path,
    changed_paths: &mut Vec<String>,
) -> (usize, usize, usize, usize) {
    let learned_index_path = workspace_dir.join(LEARNED_INDEX_RELATIVE_PATH);
    let learned_blocks_dir = workspace_dir.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH);
    let usage_path = workspace_dir.join(LEARNED_USAGE_RELATIVE_PATH);
    let usage = load_learned_usage(&usage_path);
    let now_ms = now_millis();

    let before = fs::read(&learned_index_path).map(|b| b.len()).unwrap_or(0);

    let mut blocks: Vec<(String, u32, u128, u128, u128, u128, String)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&learned_blocks_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !path.is_dir() {
                continue;
            }
            if name.starts_with('.') || name.starts_with('_') {
                continue;
            }
            let skill_path = path.join("SKILL.md");
            if !skill_path.is_file() {
                continue;
            }
            let modified = fs::metadata(&skill_path)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let mtime_key = system_time_sort_key(modified);
            let skill_text = fs::read_to_string(&skill_path).unwrap_or_default();
            let quality_penalty = learned_block_quality_penalty(skill_text.as_str());
            let desc = describe_block(&skill_path);

            let usage_entry = usage.blocks.get(name.as_str());
            let uses = usage_entry.map(|entry| entry.uses).unwrap_or(0);
            let last_used_ms = usage_entry
                .and_then(|entry| entry.last_used_ms)
                .unwrap_or(mtime_key as u64) as u128;

            let age_since_used_secs = if last_used_ms == 0 {
                u64::MAX
            } else {
                now_ms.saturating_sub(last_used_ms as u64) / 1000
            };

            // Demote cold/low-use blocks so high-frequency ones stay discoverable in the capped index.
            let cold_rank = if uses == 0 && age_since_used_secs > COLD_BLOCK_UNUSED_TTL_SECS {
                2u128
            } else if uses <= 1 && age_since_used_secs > COLD_BLOCK_LOW_USE_TTL_SECS {
                1u128
            } else {
                0u128
            };

            blocks.push((
                name,
                uses,
                cold_rank,
                quality_penalty,
                last_used_ms,
                mtime_key,
                desc,
            ));
        }
    }
    blocks.sort_by(|a, b| {
        // (uses desc, cold_rank asc, quality_penalty asc, last_used desc, mtime desc, name asc)
        b.1.cmp(&a.1)
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.3.cmp(&b.3))
            .then_with(|| b.4.cmp(&a.4))
            .then_with(|| b.5.cmp(&a.5))
            .then_with(|| a.0.cmp(&b.0))
    });

    let total_blocks = blocks.len();
    let mut active_blocks = MAX_LEARNED_INDEX_BLOCKS.min(total_blocks);

    // Build index content using the canonical template and insert a short list.
    let template = LEARNED_INDEX_TEMPLATE.to_string();
    let marker = "<!-- /learn will keep this section short and updated. -->";

    let mut indexed_names: Vec<String> = Vec::new();
    let new_index = loop {
        indexed_names.clear();
        let mut bullets = String::new();
        for (name, _uses, _cold_rank, quality_penalty, _last_used, _mtime, desc) in
            blocks.iter().take(active_blocks)
        {
            if *quality_penalty >= 4 {
                continue;
            }
            indexed_names.push(name.clone());
            bullets.push_str(&format!("- [`{name}`](blocks/{name}/SKILL.md): {desc}\n"));
        }
        let insert = if bullets.is_empty() {
            marker.to_string()
        } else {
            format!("{marker}\n\n{bullets}")
        };
        let candidate = template.replace(marker, insert.as_str());

        if candidate.as_bytes().len() <= MAX_LEARNED_INDEX_BYTES || active_blocks <= 1 {
            break candidate;
        }
        // Too large: shrink the list.
        active_blocks = active_blocks.saturating_sub(1);
    };

    let after = new_index.as_bytes().len();
    if write_file_if_changed(&learned_index_path, new_index.as_str()) {
        changed_paths.push(LEARNED_INDEX_RELATIVE_PATH.to_string());
    }

    // Keep an archive list (not loaded by default) so we don't lose history while keeping the index small.
    let indexed_set: HashSet<String> = indexed_names.iter().cloned().collect();
    let archived_blocks: Vec<_> = blocks
        .iter()
        .filter(
            |(name, _uses, _cold_rank, _quality_penalty, _last_used, _mtime, _desc)| {
                !indexed_set.contains(name)
            },
        )
        .collect();

    let _archived_count = if !archived_blocks.is_empty() {
        let mut archive_lines = String::new();
        archive_lines.push_str("# Learned blocks archive\n\n");
        archive_lines.push_str("Blocks not currently indexed in `instafy-learned/SKILL.md`.\n\n");
        for (name, _uses, _cold_rank, _quality_penalty, _last_used, _mtime, desc) in
            archived_blocks.iter().copied()
        {
            archive_lines.push_str(&format!("- `{name}`: {desc}\n"));
        }
        let archive_path = workspace_dir
            .join(SKILLS_ROOT_RELATIVE_PATH)
            .join("instafy-learned")
            .join("ARCHIVE.md");
        if write_file_if_changed(&archive_path, archive_lines.as_str()) {
            if let Ok(relative) = archive_path.strip_prefix(workspace_dir) {
                changed_paths.push(relative.to_string_lossy().to_string());
            }
        }
        archived_blocks.len()
    } else {
        0
    };

    (before, after, total_blocks, indexed_names.len())
}

pub fn optimize_learned_memory(
    workspace_dir: &Path,
    conversation_text: Option<&str>,
) -> Option<LearnOptimizerResult> {
    let mut changed_paths: Vec<String> = Vec::new();

    // Update learned-block usage metadata based on the recent conversation, then rebuild the
    // learned index so the most useful blocks remain discoverable within the capped index.
    let (usage_before, usage_after, usage_marked_used) = update_learned_usage_from_conversation(
        workspace_dir,
        conversation_text,
        &mut changed_paths,
    );

    let (instafy_before, instafy_after) = optimize_instafy_md(workspace_dir, &mut changed_paths);
    let (learned_index_before, learned_index_after, blocks_total, blocks_indexed) =
        optimize_learned_index(workspace_dir, &mut changed_paths);

    if changed_paths.is_empty() {
        return None;
    }

    changed_paths.sort();
    changed_paths.dedup();

    Some(LearnOptimizerResult {
        changed_paths,
        instafy_bytes_before: instafy_before,
        instafy_bytes_after: instafy_after,
        learned_index_bytes_before: learned_index_before,
        learned_index_bytes_after: learned_index_after,
        blocks_total,
        blocks_indexed,
        usage_entries_before: usage_before,
        usage_entries_after: usage_after,
        usage_blocks_marked_used: usage_marked_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn collaboration_guidance_keeps_sharing_on_interactive_user_surfaces() {
        for template in [COLLABORATION_TEMPLATE, SKILL_ROUTER_TEMPLATE] {
            assert!(template.contains("/invite"));
            assert!(template.contains("Invite"));
            assert!(!template.contains("instafy space invite"));
            assert!(!template.contains("instafy space role"));
        }
        assert!(COLLABORATION_TEMPLATE.contains("CONTROLLER_ACCESS_TOKEN"));
        assert!(COLLABORATION_TEMPLATE.contains("viewer"));
        assert!(COLLABORATION_TEMPLATE.contains("builder"));
    }

    #[test]
    fn diagnostics_guidance_and_claude_bridge_are_seeded() {
        let tmp = tempdir().expect("temp dir");

        ensure_project_memory_scaffold(tmp.path());

        assert_eq!(
            fs::read_to_string(tmp.path().join(CLAUDE_DOC_FILENAME)).expect("read Claude bridge"),
            CLAUDE_DOC_TEMPLATE
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join(DIAGNOSTICS_RELATIVE_PATH))
                .expect("read diagnostics skill"),
            DIAGNOSTICS_TEMPLATE
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join(DIAGNOSTICS_OPENAI_RELATIVE_PATH))
                .expect("read diagnostics OpenAI metadata"),
            DIAGNOSTICS_OPENAI_TEMPLATE
        );
        assert!(DIAGNOSTICS_TEMPLATE.contains("instafy diagnostics run-result"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("returned `runId`"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("returned `spaceId`"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("every returned event's `runtimeId`"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("correlation, not proof of causation"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("--preview"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("obtain explicit confirmation"));
        assert!(DIAGNOSTICS_TEMPLATE.contains("never bypass a traversal, symlink"));
        assert_eq!(CLAUDE_DOC_TEMPLATE, "@AGENTS.md\n");
    }

    #[test]
    fn group_participation_guidance_is_seeded_and_kept_current() {
        let tmp = tempdir().expect("temp dir");
        let path = tmp.path().join(GROUP_PARTICIPATION_RELATIVE_PATH);

        ensure_project_memory_scaffold(tmp.path());
        assert_eq!(
            fs::read_to_string(&path).expect("read group participation skill"),
            GROUP_PARTICIPATION_TEMPLATE
        );

        fs::write(&path, "stale policy\n").expect("write stale policy");
        ensure_project_memory_scaffold(tmp.path());
        let refreshed = fs::read_to_string(&path).expect("read refreshed policy");
        assert_eq!(refreshed, GROUP_PARTICIPATION_TEMPLATE);
        assert!(refreshed.contains("context_kind: policy"));
        assert!(refreshed.contains("context_parent: instafy-persistent-contexts"));
        assert!(refreshed.contains("always_include: true"));
        assert!(refreshed.contains(
            "`groupParticipation` decisions (`respond`, `claim`, `correct`, or `silent`"
        ));
        assert!(refreshed.contains("Do not add an artificial waiting period"));
        assert!(refreshed.contains("do not call tools"));
    }

    #[test]
    fn group_participation_policy_is_delivered_in_full_after_scaffold_refresh() {
        let tmp = tempdir().expect("temp dir");
        let path = tmp.path().join(GROUP_PARTICIPATION_RELATIVE_PATH);
        let question = "What follows from the rule already supplied in this conversation?";

        ensure_project_memory_scaffold(tmp.path());
        let snapshot = super::super::format_project_memory_snapshot(tmp.path(), question)
            .expect("ordinary main-turn memory snapshot");
        assert_eq!(
            snapshot
                .text
                .matches(GROUP_PARTICIPATION_TEMPLATE.trim())
                .count(),
            1
        );

        // Existing workspaces must receive the same complete pinned policy as new ones,
        // rather than retaining an obsolete decision procedure or only its index entry.
        fs::write(&path, "obsolete participation policy").expect("write old policy");
        ensure_project_memory_scaffold(tmp.path());
        let refreshed = super::super::format_project_memory_snapshot(tmp.path(), question)
            .expect("refreshed main-turn memory snapshot");
        assert_eq!(
            refreshed
                .text
                .matches(GROUP_PARTICIPATION_TEMPLATE.trim())
                .count(),
            1
        );
        assert!(!refreshed.text.contains("obsolete participation policy"));
    }

    #[test]
    fn git_sync_guidance_keeps_remote_writes_in_the_runtime_owned_sync_path() {
        // This asserted the same rules twice: against the skill that ships to
        // workspaces, and against a near-identical copy under `learnings/_pinned`
        // that nothing loaded. The copy is gone; the shipped artifact is still
        // the thing under test.
        let template = GIT_CANONICAL_TEMPLATE;
        assert!(template.contains("CONTROLLER_ACCESS_TOKEN"));
        assert!(template.contains("git.read"));
        assert!(template.contains("/sync"));
        assert!(template.contains("controlled post-turn workspace checkpoint"));
        assert!(!template.contains("git.write"));
        assert!(!template.contains("credential.helper"));
        assert!(!template.contains("push origin HEAD:main"));
        assert!(!template.contains("RUNTIME_ACCESS_TOKEN"));
        assert!(!template.contains("ORIGIN_ACCESS_TOKEN"));
        assert!(!template.contains("ORIGIN_INTERNAL_TOKEN"));
    }

    #[test]
    fn parse_learn_request_requires_explicit_command() {
        assert_eq!(parse_learn_request(""), None);
        assert_eq!(parse_learn_request("learn"), None);
        assert_eq!(parse_learn_request("please learn this"), None);
        assert_eq!(parse_learn_request("/retro"), None);
    }

    #[test]
    fn parse_learn_apply_default_lookback() {
        assert_eq!(
            parse_learn_request("/learn"),
            Some(LearnRequest {
                mode: LearnMode::Apply,
                lookback: DEFAULT_LOOKBACK,
            })
        );
    }

    #[test]
    fn parse_learn_collect_variants() {
        assert_eq!(
            parse_learn_request("/learn collect"),
            Some(LearnRequest {
                mode: LearnMode::Collect,
                lookback: DEFAULT_LOOKBACK,
            })
        );
        assert_eq!(
            parse_learn_request("/learn collect 6"),
            Some(LearnRequest {
                mode: LearnMode::Collect,
                lookback: 6,
            })
        );
        assert_eq!(
            parse_learn_request("/learn:collect 10"),
            Some(LearnRequest {
                mode: LearnMode::Collect,
                lookback: 10,
            })
        );
    }

    #[test]
    fn parse_learn_apply_with_lookback() {
        assert_eq!(
            parse_learn_request("/learn 42"),
            Some(LearnRequest {
                mode: LearnMode::Apply,
                lookback: 42,
            })
        );
        assert_eq!(
            parse_learn_request("/learn apply 7"),
            Some(LearnRequest {
                mode: LearnMode::Apply,
                lookback: 7,
            })
        );
    }

    #[test]
    fn optimize_learned_memory_enforces_budgets_and_archives_overflow() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        // Oversize INSTAFY.md so the optimizer has deterministic work to do.
        let mut instafy = String::from("# INSTAFY.md\n\n");
        for i in 0..2500 {
            instafy.push_str(&format!("- line {i}: {}\n", "x".repeat(12)));
        }
        fs::write(root.join(INSTAFY_FILENAME), instafy).expect("write INSTAFY.md");

        // Seed many learned blocks so the index needs pruning.
        for i in 1..=30 {
            let name = format!("block-{i:02}");
            let dir = root.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH).join(&name);
            fs::create_dir_all(&dir).expect("create block dir");
            let content = format!(
                "---\n\
description: Deterministic block {i}\n\
---\n\
\n\
# {name}\n\
\n\
Apply when: test harness wants deterministic blocks.\n"
            );
            fs::write(dir.join("SKILL.md"), content).expect("write block SKILL.md");
        }

        // Overwrite the learned index with garbage to guarantee the optimizer rewrites it.
        let index_path = root.join(LEARNED_INDEX_RELATIVE_PATH);
        fs::create_dir_all(index_path.parent().expect("index parent")).expect("create index dir");
        fs::write(&index_path, "X".repeat(20_000)).expect("write learned index garbage");

        let result =
            optimize_learned_memory(root, None).expect("optimizer should change something");
        assert!(
            result.instafy_bytes_before > MAX_INSTAFY_MD_BYTES,
            "expected INSTAFY.md to start oversize"
        );
        assert!(
            result.learned_index_bytes_after <= MAX_LEARNED_INDEX_BYTES,
            "expected learned index to be capped"
        );

        let instafy_after =
            fs::read_to_string(root.join(INSTAFY_FILENAME)).expect("read INSTAFY.md");
        assert!(
            instafy_after.contains("Truncated by `/learn` optimizer"),
            "expected truncation marker"
        );

        let overflow_path = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("instafy-memory-overflow")
            .join("DETAILS.md");
        let overflow = fs::read_to_string(&overflow_path).expect("read overflow details");
        assert!(
            overflow.contains("Overflow content"),
            "expected overflow details to include the moved content section"
        );

        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        let bullet_count = index_after
            .lines()
            .filter(|line| line.trim_start().starts_with("- [`"))
            .count();
        assert!(
            bullet_count <= MAX_LEARNED_INDEX_BLOCKS,
            "expected index bullet count to be capped"
        );

        let archive_path = root
            .join(SKILLS_ROOT_RELATIVE_PATH)
            .join("instafy-learned")
            .join("ARCHIVE.md");
        let archive = fs::read_to_string(&archive_path).expect("read archive");
        let archive_count = archive
            .lines()
            .filter(|line| line.trim_start().starts_with("- `block-"))
            .count();
        assert!(
            archive_count >= 30usize.saturating_sub(bullet_count),
            "expected archive to contain the non-indexed blocks"
        );
    }

    #[test]
    fn optimize_learned_memory_small_bloated_corpus_shrinks_active_surface() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        let mut instafy = String::from("# INSTAFY.md\n\n");
        for i in 0..700 {
            instafy.push_str(&format!(
                "- repeated-note-{i}: this line is synthetic benchmark filler that should not remain in the compact memory file.\n"
            ));
        }
        fs::write(root.join(INSTAFY_FILENAME), instafy).expect("write INSTAFY.md");

        for i in 1..=4 {
            let name = format!("bloated-block-{i:02}");
            let dir = root.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH).join(&name);
            fs::create_dir_all(&dir).expect("create block dir");
            let content = format!(
                "---\n\
name: {name}\n\
description: Oversized benchmark block {i}.\n\
---\n\
\n\
# {name}\n\
\n\
Apply when: any vaguely similar task.\n\
\n\
Procedure:\n\
1. Consider many options.\n\
2. Consider more options.\n\
\n\
Stop/verify conditions:\n\
- Stop eventually.\n"
            );
            fs::write(dir.join("SKILL.md"), content).expect("write block SKILL.md");
        }

        let mut bloated_index = LEARNED_INDEX_TEMPLATE.replace(
            "<!-- /learn will keep this section short and updated. -->",
            "<!-- /learn will keep this section short and updated. -->\n\n\
- [`bloated-block-01`](blocks/bloated-block-01/SKILL.md): verbose low-signal benchmark routing hint repeated many times repeated many times repeated many times.\n\
- [`bloated-block-02`](blocks/bloated-block-02/SKILL.md): verbose low-signal benchmark routing hint repeated many times repeated many times repeated many times.\n\
- [`bloated-block-03`](blocks/bloated-block-03/SKILL.md): verbose low-signal benchmark routing hint repeated many times repeated many times repeated many times.\n\
- [`bloated-block-04`](blocks/bloated-block-04/SKILL.md): verbose low-signal benchmark routing hint repeated many times repeated many times repeated many times.\n",
        );
        bloated_index.push_str(&"X".repeat(8_000));
        fs::create_dir_all(root.join(SKILLS_ROOT_RELATIVE_PATH).join("instafy-learned"))
            .expect("create learned dir");
        fs::write(root.join(LEARNED_INDEX_RELATIVE_PATH), &bloated_index)
            .expect("write learned index");

        let result =
            optimize_learned_memory(root, None).expect("optimizer should change something");
        assert!(result.instafy_bytes_after < result.instafy_bytes_before);
        assert!(result.learned_index_bytes_after < result.learned_index_bytes_before);

        let instafy_after =
            fs::read_to_string(root.join(INSTAFY_FILENAME)).expect("read INSTAFY.md");
        assert!(instafy_after.contains("Truncated by `/learn` optimizer"));

        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        let bullet_count = index_after
            .lines()
            .filter(|line| line.trim_start().starts_with("- [`"))
            .count();
        assert!(
            bullet_count <= 4,
            "expected active index surface to stay small"
        );
        assert!(
            index_after.len() < bloated_index.len(),
            "expected learned index to shrink"
        );
    }

    #[test]
    fn optimize_learned_memory_small_corpus_does_not_require_archive() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        fs::write(root.join(INSTAFY_FILENAME), "# INSTAFY.md\n\nsmall\n")
            .expect("write INSTAFY.md");
        fs::create_dir_all(root.join(SKILLS_ROOT_RELATIVE_PATH).join("instafy-learned"))
            .expect("create learned dir");
        fs::write(
            root.join(LEARNED_INDEX_RELATIVE_PATH),
            {
                let mut text = LEARNED_INDEX_TEMPLATE.replace(
                "<!-- /learn will keep this section short and updated. -->",
                "<!-- /learn will keep this section short and updated. -->\n\n\
- [`bloated-block-01`](blocks/bloated-block-01/SKILL.md): noisy benchmark hint one one one one one.\n\
- [`bloated-block-02`](blocks/bloated-block-02/SKILL.md): noisy benchmark hint two two two two two.\n\
- [`bloated-block-03`](blocks/bloated-block-03/SKILL.md): noisy benchmark hint three three three three three.\n\
- [`bloated-block-04`](blocks/bloated-block-04/SKILL.md): noisy benchmark hint four four four four four.\n",
                );
                text.push_str(&"Y".repeat(10_000));
                text
            },
        )
        .expect("write learned index");

        for i in 1..=4 {
            let name = format!("bloated-block-{i:02}");
            let dir = root.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH).join(&name);
            fs::create_dir_all(&dir).expect("create block dir");
            fs::write(
                dir.join("SKILL.md"),
                format!(
                    "---\nname: {name}\ndescription: Compact block {i}.\n---\n\n# {name}\n\nApply when: test.\n\n## Verify\n- done\n"
                ),
            )
            .expect("write block skill");
        }

        let result = optimize_learned_memory(root, None).expect("optimizer should rewrite index");
        assert!(result.learned_index_bytes_after <= result.learned_index_bytes_before);

        let archive_path = root
            .join(SKILLS_ROOT_RELATIVE_PATH)
            .join("instafy-learned")
            .join("ARCHIVE.md");
        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        let bullet_count = index_after
            .lines()
            .filter(|line| line.trim_start().starts_with("- [`"))
            .count();

        assert!(bullet_count <= 4);
        assert!(
            !archive_path.exists(),
            "small corpora that fit within the active block cap should not require an archive"
        );
        assert!(
            index_after.len() <= MAX_LEARNED_INDEX_BYTES,
            "expected optimizer to rewrite the bloated small index into the capped canonical form"
        );
    }

    #[test]
    fn optimize_learned_index_demotes_replay_style_block_from_active_index() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        fs::write(root.join(INSTAFY_FILENAME), "# INSTAFY.md\n\nsmall\n").expect("write instafy");
        let learned_dir = root.join(SKILLS_ROOT_RELATIVE_PATH).join("instafy-learned");
        fs::create_dir_all(&learned_dir).expect("create learned dir");
        fs::write(
            root.join(LEARNED_INDEX_RELATIVE_PATH),
            LEARNED_INDEX_TEMPLATE,
        )
        .expect("write learned index");

        let good_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("good-heuristic");
        fs::create_dir_all(&good_dir).expect("create good block");
        fs::write(
            good_dir.join("SKILL.md"),
            "---\nname: good-heuristic\ndescription: Compact benchmark heuristic.\n---\n\n# good-heuristic\n\n## Apply when\n- searching the local fixture site\n\n## Landmarks\n- input name=q\n- button text=Go\n\n## Verify\n- article token read from page text\n",
        )
        .expect("write good block");

        let bad_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("bad-replay");
        fs::create_dir_all(&bad_dir).expect("create bad block");
        fs::write(
            bad_dir.join("SKILL.md"),
            "---\nname: bad-replay\ndescription: Replay style benchmark block.\n---\n\n# bad-replay\n\n## Apply when\n- this exact benchmark appears again\n\n## Look first\n- run exactly `bash -lc 'node - <<'\"'\"'NODE'\"'\"''`\n\n## Verify\n- use the copied script output as the answer\n",
        )
        .expect("write bad block");

        let result = optimize_learned_memory(root, None).expect("optimizer should rewrite index");
        assert_eq!(result.blocks_total, 2);

        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        assert!(index_after.contains("good-heuristic"));
        assert!(!index_after.contains("bad-replay"));

        let archive = fs::read_to_string(learned_dir.join("ARCHIVE.md")).expect("read archive");
        assert!(archive.contains("bad-replay"));
    }

    #[test]
    fn optimize_learned_index_demotes_generic_low_signal_block() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        fs::write(root.join(INSTAFY_FILENAME), "# INSTAFY.md\n\nsmall\n").expect("write instafy");
        let learned_dir = root.join(SKILLS_ROOT_RELATIVE_PATH).join("instafy-learned");
        fs::create_dir_all(&learned_dir).expect("create learned dir");
        fs::write(
            root.join(LEARNED_INDEX_RELATIVE_PATH),
            LEARNED_INDEX_TEMPLATE,
        )
        .expect("write learned index");

        let good_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("exact-literal-answer");
        fs::create_dir_all(&good_dir).expect("create good block");
        fs::write(
            good_dir.join("SKILL.md"),
            "---\nname: exact-literal-answer\ndescription: Literal answer heuristic.\n---\n\n# exact-literal-answer\n\n## Apply when\n- the harness asks for an exact literal answer\n\n## Look first\n- final visible assistant instruction\n\n## Verify\n- assistant reply matches the literal string exactly\n",
        )
        .expect("write good block");

        let bad_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("generic-browser-bloat");
        fs::create_dir_all(&bad_dir).expect("create bad block");
        fs::write(
            bad_dir.join("SKILL.md"),
            "---\nname: generic-browser-bloat\ndescription: Vague benchmark block.\n---\n\n# generic-browser-bloat\n\nApply when: any memory question or any vaguely similar activity.\n\nProcedure:\n1. Consider many possible options.\n2. Continue considering options before acting.\n\nStop/verify conditions:\n- Stop eventually.\n- Verify vaguely.\n",
        )
        .expect("write bad block");

        let result = optimize_learned_memory(root, None).expect("optimizer should rewrite index");
        assert_eq!(result.blocks_total, 2);

        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        assert!(index_after.contains("exact-literal-answer"));
        assert!(!index_after.contains("generic-browser-bloat"));

        let archive = fs::read_to_string(learned_dir.join("ARCHIVE.md")).expect("read archive");
        assert!(archive.contains("generic-browser-bloat"));
    }

    #[test]
    fn optimize_learned_index_demotes_block_with_example_output_and_execution_replay() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        fs::write(root.join(INSTAFY_FILENAME), "# INSTAFY.md\n\nsmall\n").expect("write instafy");
        let learned_dir = root.join(SKILLS_ROOT_RELATIVE_PATH).join("instafy-learned");
        fs::create_dir_all(&learned_dir).expect("create learned dir");
        fs::write(
            root.join(LEARNED_INDEX_RELATIVE_PATH),
            LEARNED_INDEX_TEMPLATE,
        )
        .expect("write learned index");

        let good_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("fixture-news-search");
        fs::create_dir_all(&good_dir).expect("create good block");
        fs::write(
            good_dir.join("SKILL.md"),
            "---\nname: fixture-news-search\ndescription: Specific route cue for the local search page.\n---\n\n# fixture-news-search\n\n- Apply when: the local fixture asks for the Beta article.\n- Look first: start from `/search`, use the search term as the slug hint, and open the matching Beta result.\n- Verify: finish only when the page URL is `/article/beta` and the article heading is visible.\n",
        )
        .expect("write good block");

        let bad_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("fixture-news-search-article");
        fs::create_dir_all(&bad_dir).expect("create bad block");
        fs::write(
            bad_dir.join("SKILL.md"),
            "---\nname: fixture-news-search-article\ndescription: Replays exact execution and stores an example output.\n---\n\n# Fixture news search article\n\n## Apply when\n- the local fixture asks for the Beta article\n\n## Look first\n- run exactly `bash -lc 'node - <<'\"'\"'NODE'\"'\"''`\n\n## Verify\n- the learned Beta example produced token `BETA-TOKEN-2a4e19`.\n",
        )
        .expect("write bad block");

        let result = optimize_learned_memory(root, None).expect("optimizer should rewrite index");
        assert_eq!(result.blocks_total, 2);

        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        assert!(index_after.contains("fixture-news-search"));
        assert!(!index_after.contains("fixture-news-search-article"));

        let archive = fs::read_to_string(learned_dir.join("ARCHIVE.md")).expect("read archive");
        assert!(archive.contains("fixture-news-search-article"));
    }

    #[test]
    fn optimize_learned_index_demotes_block_that_only_stores_example_output_value() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        fs::write(root.join(INSTAFY_FILENAME), "# INSTAFY.md\n\nsmall\n").expect("write instafy");
        let learned_dir = root.join(SKILLS_ROOT_RELATIVE_PATH).join("instafy-learned");
        fs::create_dir_all(&learned_dir).expect("create learned dir");
        fs::write(
            root.join(LEARNED_INDEX_RELATIVE_PATH),
            LEARNED_INDEX_TEMPLATE,
        )
        .expect("write learned index");

        let good_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("article-token-reader");
        fs::create_dir_all(&good_dir).expect("create good block");
        fs::write(
            good_dir.join("SKILL.md"),
            "---\nname: article-token-reader\ndescription: Retrieval cues for an article token.\n---\n\n# article-token-reader\n\n## Apply when\n- the task asks for the article token on the article page\n\n## Look first\n- read the label `ARTICLE_TOKEN`\n\n## Verify\n- finish only when the token label is visible on the article page\n",
        )
        .expect("write good block");

        let bad_dir = root
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("article-token-literal");
        fs::create_dir_all(&bad_dir).expect("create bad block");
        fs::write(
            bad_dir.join("SKILL.md"),
            "---\nname: article-token-literal\ndescription: Stores the example token value.\n---\n\n# article-token-literal\n\n## Apply when\n- the task asks for the article token\n\n## Look first\n- open the article page\n\n## Verify\n- the learned example produced token `BETA-TOKEN-2a4e19`\n",
        )
        .expect("write bad block");

        let result = optimize_learned_memory(root, None).expect("optimizer should rewrite index");
        assert_eq!(result.blocks_total, 2);

        let index_after =
            fs::read_to_string(root.join(LEARNED_INDEX_RELATIVE_PATH)).expect("read learned index");
        assert!(index_after.contains("article-token-reader"));
        assert!(!index_after.contains("article-token-literal"));

        let archive = fs::read_to_string(learned_dir.join("ARCHIVE.md")).expect("read archive");
        assert!(archive.contains("article-token-literal"));
    }

    #[test]
    fn extract_used_learned_block_names_finds_paths_in_text() {
        let sample = r#"
bash -lc 'cat .agents/skills/instafy-learned/blocks/block-01/SKILL.md'
bash -lc 'cat blocks/block-02/DETAILS.md'
User: please use block-03
"#;
        let used = extract_used_learned_block_names(sample);
        assert!(used.contains("block-01"));
        assert!(used.contains("block-02"));
        assert!(!used.contains("block-03")); // requires a path reference, not just the name
    }

    #[test]
    fn update_learned_usage_from_conversation_writes_usage_file() {
        let workspace = tempdir().expect("workspace tempdir");
        let root = workspace.path();

        let block_dir = root.join(LEARNED_BLOCKS_DIR_RELATIVE_PATH).join("block-01");
        fs::create_dir_all(&block_dir).expect("create block dir");
        fs::write(block_dir.join("SKILL.md"), "# block-01\n").expect("write SKILL.md");

        let mut changed_paths = Vec::new();
        let (before, after, marked) = update_learned_usage_from_conversation(
            root,
            Some("bash -lc 'cat .agents/skills/instafy-learned/blocks/block-01/SKILL.md'"),
            &mut changed_paths,
        );
        assert_eq!(before, 0);
        assert!(after >= 1);
        assert!(marked >= 1);
        assert!(
            changed_paths
                .iter()
                .any(|p| p == LEARNED_USAGE_RELATIVE_PATH)
        );

        let usage_path = root.join(LEARNED_USAGE_RELATIVE_PATH);
        let usage = load_learned_usage(&usage_path);
        let entry = usage.blocks.get("block-01").expect("usage entry exists");
        assert!(entry.uses >= 1);
        assert!(entry.last_used_ms.is_some());
    }
}

pub fn extract_model_from_codex_event(event: &JsonValue) -> Option<String> {
    for pointer in [
        "/model",
        "/response/model",
        "/event/response/model",
        "/data/response/model",
        "/metadata/model",
    ] {
        if let Some(model) = event.pointer(pointer).and_then(JsonValue::as_str) {
            let trimmed = model.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    find_first_model_string(event, 0)
}

fn find_first_model_string(value: &JsonValue, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }

    match value {
        JsonValue::Object(map) => {
            if let Some(model) = map.get("model").and_then(JsonValue::as_str) {
                let trimmed = model.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            for child in map.values() {
                if let Some(found) = find_first_model_string(child, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        JsonValue::Array(values) => {
            for child in values {
                if let Some(found) = find_first_model_string(child, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}
