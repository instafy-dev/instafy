//! Showing a site that runs in the space: which bundled skills the router picks for it, and the
//! skill hints a restored provider thread or a direct workspace-change turn gets, neither of which loads a
//! workspace memory snapshot.

use super::tests::{test_job_processor, test_lease_job};
use super::*;
use tempfile::tempdir;

const PREVIEWS: &str = "instafy-frontend-previews";
const BROWSER: &str = "instafy-browser-automation";

fn scaffolded_space() -> tempfile::TempDir {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    tmp
}

fn routed(contexts: &[ContextNode], prompt: &str) -> Vec<String> {
    select_recursive_context_nodes(contexts, prompt)
        .into_iter()
        .filter(|node| node.score > 0)
        .map(|node| node.id)
        .collect()
}

#[test]
fn a_site_running_in_the_space_routes_to_previews_over_the_bundled_skills() {
    let tmp = scaffolded_space();
    let contexts = build_top_level_context_nodes(tmp.path());
    for prompt in [
        // `page` is a browser keyword too, so both may be picked here; the browser
        // skill's first section points a site in this space to previews.
        "make a tiny hello page and show me a preview",
        "I have a server on port 8000, show it as a preview card",
        "can I see the dev server on localhost:5173",
        "visa förhandsvisning av sidan",
        "run a simple static file server on port 8000 in this folder and show it to me as a preview card",
    ] {
        assert!(
            routed(&contexts, prompt).iter().any(|id| id == PREVIEWS),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }
    let public = routed(&contexts, "look up the pricing page on example.com");
    assert!(public.iter().any(|id| id == BROWSER), "{public:?}");
    assert!(!public.iter().any(|id| id == PREVIEWS), "{public:?}");
    for prompt in [
        "port this function to TypeScript",
        "rename userId to accountId",
    ] {
        assert!(
            !routed(&contexts, prompt).iter().any(|id| id == PREVIEWS),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }
}

/// Every hint line carries a bundled workflow skill's description whole.
#[test]
fn every_bundled_workflow_skill_description_fits_a_hint_line() {
    let tmp = scaffolded_space();
    let contexts = build_top_level_context_nodes(tmp.path());
    assert!(contexts.iter().any(|context| context.id == PREVIEWS));
    for context in contexts
        .iter()
        .filter(|context| context.metadata.context_kind.as_deref() == Some("workflow"))
    {
        let description = context.metadata.description.as_deref().unwrap_or("");
        assert!(
            description.chars().count() <= SKILL_HINT_MAX_DESCRIPTION_CHARS,
            "{}: {} characters",
            context.id,
            description.chars().count()
        );
    }
}

#[test]
fn restored_skill_hints_name_strong_matches_only_within_their_cap() {
    let tmp = scaffolded_space();
    let hints = format_skill_hints(
        tmp.path(),
        "show the server on port 8000 as a preview",
        RESTORED_SKILL_HINTS_LEAD,
    )
    .expect("a preview request gets hints");
    assert!(hints.skills.iter().any(|id| id == PREVIEWS), "{hints:?}");
    assert!(
        hints
            .text
            .contains("(read `.agents/skills/instafy-frontend-previews/SKILL.md` before acting unless already read in this conversation)"),
        "{}",
        hints.text
    );
    assert!(hints.text.len() <= SKILL_HINTS_MAX_BYTES);
    assert!(hints.skills.len() <= SKILL_HINT_MAX_SKILLS);
    // Body prose alone (skills without keywords route on it) is below the threshold.
    assert_eq!(
        format_skill_hints(tmp.path(), "rename the variable", RESTORED_SKILL_HINTS_LEAD),
        None
    );
}

fn restored_prompt(
    tmp: &Path,
    request: &str,
    include_workspace_memory: bool,
    payload: JsonValue,
) -> (String, JsonValue) {
    let processor = test_job_processor(tmp);
    let project_id = Uuid::new_v4();
    let mut job = test_lease_job(Some("feature"), payload);
    job.project_id = Some(project_id);
    let provider_state =
        json!({"defaultThreadId": "existing-thread", "historyReplayRequired": false});
    let (prompt, _, metrics) = processor
        .build_prompt_with_text(
            &project_id,
            &job,
            tmp,
            request,
            include_workspace_memory,
            Some(&provider_state),
            &[],
            None,
            None,
        )
        .expect("prompt should build");
    assert_eq!(metrics["promptMode"], "stateful_compact");
    (prompt, metrics)
}

#[test]
fn a_restored_thread_is_told_which_skills_match_the_request() {
    let tmp = scaffolded_space();
    let request = "run a simple static file server on port 8000 in this folder and show it to me as a preview card";
    let (prompt, metrics) = restored_prompt(tmp.path(), request, true, json!({"metadata": {}}));
    assert!(prompt.contains("Workspace memory snapshot omitted"));
    assert!(prompt.contains("Skills that match this request"));
    assert!(prompt.contains(".agents/skills/instafy-frontend-previews/SKILL.md"));
    assert!(
        prompt.find("Skills that match this request") < prompt.find("Latest user request:"),
        "the hints come before the request"
    );
    assert!(
        metrics["restoredSkillHints"]
            .as_array()
            .expect("hinted skills in metrics")
            .iter()
            .any(|id| id == PREVIEWS)
    );
    assert!(
        metrics["promptSections"]["restoredSkillHints"]["chars"]
            .as_u64()
            .unwrap()
            > 0
    );
    // Both first and restored turns say what Instafy's browser can open.
    assert!(prompt.contains("public web addresses only"));
    assert!(BROWSER_CHOICE_CONTRACT.contains("public web addresses only"));
    assert!(BROWSER_CHOICE_CONTRACT.contains("safety policy blocks this space's own addresses"));
}

#[test]
fn restored_skill_hints_stay_off_weak_matches_memoryless_and_browser_turns() {
    let tmp = scaffolded_space();
    let (prompt, metrics) = restored_prompt(
        tmp.path(),
        "rename the variable",
        true,
        json!({"metadata": {}}),
    );
    assert!(!prompt.contains("Skills that match this request"));
    assert!(metrics.get("restoredSkillHints").is_none());

    let request = "show the server on port 8000 as a preview";
    let (prompt, _) = restored_prompt(tmp.path(), request, false, json!({"metadata": {}}));
    assert!(!prompt.contains("Skills that match this request"));

    let (prompt, _) = restored_prompt(
        tmp.path(),
        request,
        true,
        json!({"metadata": {"browserTransport": "shared"}}),
    );
    assert!(!prompt.contains("Skills that match this request"));
}

fn direct_write_prompt(tmp: &Path, request: &str, metadata: JsonValue) -> (String, JsonValue) {
    let processor = test_job_processor(tmp);
    let project_id = Uuid::new_v4();
    let mut job = test_lease_job(Some("feature"), json!({ "metadata": metadata }));
    job.project_id = Some(project_id);
    let (prompt, _, metrics) = processor
        .build_prompt_with_text(&project_id, &job, tmp, request, true, None, &[], None, None)
        .expect("prompt should build");
    assert!(prompt.contains("Direct workspace-change response contract"));
    assert!(
        prompt.contains("Workspace memory snapshot skipped for this direct workspace-change run")
    );
    (prompt, metrics)
}

/// "Make a page and show me a preview" is a file change, so the routing preflight sends it to the direct
/// workspace-change lane, which loads no workspace memory snapshot. It is told which skills match, the
/// same way as a restored thread, so the preview skill is not lost on the turn that builds the site.
#[test]
fn a_direct_workspace_change_turn_is_told_which_skills_match_the_request() {
    let tmp = scaffolded_space();
    let write = json!({"runtimeExpectations": {"workspaceFileChanges": true}});
    let (prompt, metrics) = direct_write_prompt(
        tmp.path(),
        "make a tiny hello page and show me a preview",
        write.clone(),
    );
    assert!(
        prompt.contains(
            "Skills that match this request (no workspace memory is loaded for this run;"
        )
    );
    assert!(prompt.contains(".agents/skills/instafy-frontend-previews/SKILL.md"));
    assert!(
        prompt.find("Skills that match this request") < prompt.find("Latest user request:"),
        "the hints come before the request"
    );
    assert!(
        metrics["directWriteSkillHints"]
            .as_array()
            .expect("hinted skills in metrics")
            .iter()
            .any(|id| id == PREVIEWS)
    );
    assert!(metrics.get("restoredSkillHints").is_none());

    // A plain edit names nothing.
    let (prompt, metrics) = direct_write_prompt(
        tmp.path(),
        "Create notes/hello.txt with exactly: hello world",
        write,
    );
    assert!(!prompt.contains("Skills that match this request"));
    assert!(metrics.get("directWriteSkillHints").is_none());
}
