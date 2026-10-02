//! Rebuild current shared defaults through Codex's native context lifecycle.

use std::path::PathBuf;

use codex_extension_api::{
    ContextContributor, ExtensionFuture, PreviousWorldStateSection, RenderedWorldStateFragment,
    WorldStateContributionInput, WorldStateSectionContribution,
};
use serde_json::json;
use uuid::Uuid;

use crate::jobs::ProjectPreferencesSnapshot;

const SECTION_ID: &str = "instafy_project_preferences";
const OPEN: &str = "<instafy_project_preferences>\n";
const CLOSE: &str = "</instafy_project_preferences>";

pub(super) struct ProjectPreferencesContext {
    project_id: Uuid,
    workspace_dir: PathBuf,
}

impl ProjectPreferencesContext {
    pub(super) fn new(project_id: Uuid, workspace_dir: PathBuf) -> Self {
        Self {
            project_id,
            workspace_dir,
        }
    }

    fn capture(&self) -> WorldStateSectionContribution {
        let preferences = ProjectPreferencesSnapshot::load(&self.workspace_dir);
        let body = preferences.render(&self.project_id);
        let retained = format!("{OPEN}{body}{CLOSE}");
        let mut snapshot = preferences.metrics();
        snapshot["projectId"] = json!(self.project_id);
        // Codex drops null fields from persisted World State. Use the same shape
        // so unchanged unavailable sources do not emit a notice on every step.
        snapshot
            .as_object_mut()
            .expect("preference metrics")
            .retain(|_, value| !value.is_null());
        let current = snapshot.clone();
        WorldStateSectionContribution::new(SECTION_ID, snapshot, move |previous| {
            if matches!(previous, PreviousWorldStateSection::Known(value) if value == &current) {
                return None;
            }
            Some(RenderedWorldStateFragment::new(
                "user",
                (OPEN, CLOSE),
                body.clone(),
            ))
        })
        // A stored revision alone cannot establish that the model still sees it
        // after compaction. Match the whole scoped block, including its content.
        .with_retained_fragment_matcher(move |role, text| {
            role == "user" && text.contains(&retained)
        })
    }
}

impl ContextContributor for ProjectPreferencesContext {
    fn contribute_world_state<'a>(
        &'a self,
        _input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move { vec![self.capture()] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &std::path::Path, body: &str) {
        fs::write(
            root.join("INSTAFY.md"),
            format!("## Project preferences\n{body}\n"),
        )
        .unwrap();
    }

    #[test]
    fn unchanged_defaults_require_a_retained_complete_scoped_fragment() {
        let workspace = tempfile::tempdir().unwrap();
        write(workspace.path(), "Use concise explanations.");
        let id = Uuid::new_v4();
        let context = ProjectPreferencesContext::new(id, workspace.path().to_owned());
        let section = context.capture();
        let fragment = section
            .render_diff(PreviousWorldStateSection::Absent)
            .unwrap();
        assert_eq!(fragment.role(), "user");
        assert!(!section.snapshot().to_string().contains("Use concise"));
        assert!(
            section
                .render_diff(PreviousWorldStateSection::Known(section.snapshot()))
                .is_none()
        );
        // A surviving checkpoint without model-visible context must be rehydrated.
        assert!(
            section
                .render_diff(PreviousWorldStateSection::Unknown)
                .is_some()
        );
        let visible = format!(
            "other context\n{OPEN}{}{CLOSE}\nmore context",
            fragment.body()
        );
        assert!(section.matches_retained_fragment("user", &visible));
        assert!(!section.matches_retained_fragment("developer", &visible));
        assert!(
            !section.matches_retained_fragment("user", &visible.replace("concise", "detailed"))
        );
        assert!(!section.matches_retained_fragment(
            "user",
            &visible.replace(&id.to_string(), &Uuid::new_v4().to_string())
        ));
        assert!(!section.matches_retained_fragment("user", &visible.replace(CLOSE, "")));
    }

    #[test]
    fn source_updates_withdrawal_and_unavailability_are_distinct_native_states() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("INSTAFY.md");
        write(workspace.path(), "Original default.");
        let context = ProjectPreferencesContext::new(Uuid::new_v4(), workspace.path().to_owned());
        let original = context.capture();
        write(workspace.path(), "Corrected default.");
        let corrected = context.capture();
        let update = corrected
            .render_diff(PreviousWorldStateSection::Known(original.snapshot()))
            .unwrap();
        assert!(update.body().contains("Corrected default."));
        assert!(!update.body().contains("Original default."));
        assert_ne!(
            original.snapshot()["revision"],
            corrected.snapshot()["revision"]
        );

        fs::remove_file(&path).unwrap();
        let absent = context.capture();
        let withdrawal = absent
            .render_diff(PreviousWorldStateSection::Known(corrected.snapshot()))
            .unwrap();
        assert!(
            withdrawal
                .body()
                .contains("Withdraw prior defaults for this project/source only")
        );
        assert_eq!(absent.snapshot()["state"], "empty");

        fs::write(
            &path,
            "## Project preferences\nOne\n## Project preferences\nTwo\n",
        )
        .unwrap();
        let unavailable = context.capture();
        let notice = unavailable
            .render_diff(PreviousWorldStateSection::Known(absent.snapshot()))
            .unwrap();
        assert!(notice.body().contains("not a removal or a new revision"));
        assert!(unavailable.snapshot().get("revision").is_none());
        // This is the null-free shape Codex persists, so it suppresses unchanged notices.
        assert!(
            unavailable
                .render_diff(PreviousWorldStateSection::Known(unavailable.snapshot()))
                .is_none()
        );
        assert!(
            unavailable
                .render_diff(PreviousWorldStateSection::Unknown)
                .is_some()
        );
        write(workspace.path(), "Corrected default.");
        assert!(
            context
                .capture()
                .render_diff(PreviousWorldStateSection::Known(unavailable.snapshot()))
                .is_some()
        );
    }

    #[test]
    fn registry_only_adds_preferences_for_an_explicit_project_scope() {
        use super::super::{TurnStartTokenUsage, codex_extension_registry};
        use crate::required_execution::RequiredExecutionGate;

        let usage = TurnStartTokenUsage::default();
        let gate = RequiredExecutionGate::default();
        assert!(
            codex_extension_registry(&usage, &gate, None)
                .context_contributors()
                .is_empty()
        );
        let workspace = tempfile::tempdir().unwrap();
        assert_eq!(
            codex_extension_registry(&usage, &gate, Some((Uuid::new_v4(), workspace.path())))
                .context_contributors()
                .len(),
            1
        );
    }
}
