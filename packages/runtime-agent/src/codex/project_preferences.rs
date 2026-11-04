//! Rebuild current shared defaults through Codex's native context lifecycle.

use std::path::PathBuf;

use codex_extension_api::{
    ContextContributor, ExtensionFuture, PreviousWorldStateSection, RenderedWorldStateFragment,
    WorldStateContributionInput, WorldStateSectionContribution, input_text,
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
        // Every step records the current state, whether or not it sends the block.
        WorldStateSectionContribution::new(SECTION_ID, move |previous| {
            let unchanged =
                matches!(previous, PreviousWorldStateSection::Known(value) if value == &snapshot);
            let fragment = (!unchanged).then(|| {
                RenderedWorldStateFragment::new("user", (OPEN, CLOSE), input_text(body.clone()))
            });
            (Some(snapshot.clone()), fragment)
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
    use codex_extension_api::ContentItem;
    use serde_json::Value;
    use std::fs;

    /// The state Codex records for the section; every step records the same one.
    fn snapshot_of(section: &WorldStateSectionContribution) -> Value {
        section
            .render_diff(PreviousWorldStateSection::Absent)
            .0
            .expect("a recorded state")
    }

    /// What the section sends a thread whose last recorded state is `previous`.
    fn sent(
        section: &WorldStateSectionContribution,
        previous: PreviousWorldStateSection<'_>,
    ) -> Option<RenderedWorldStateFragment> {
        section.render_diff(previous).1
    }

    /// A fragment's text.
    fn body(fragment: &RenderedWorldStateFragment) -> &str {
        match fragment.body() {
            ContentItem::InputText { text } => text,
            other => panic!("preferences are sent as text, not {other:?}"),
        }
    }

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
        let fragment = sent(&section, PreviousWorldStateSection::Absent).unwrap();
        assert_eq!(fragment.role(), "user");
        let state = snapshot_of(&section);
        assert!(!state.to_string().contains("Use concise"));
        assert!(sent(&section, PreviousWorldStateSection::Known(&state)).is_none());
        // A surviving checkpoint without model-visible context must be rehydrated.
        assert!(sent(&section, PreviousWorldStateSection::Unknown).is_some());
        let visible = format!(
            "other context\n{OPEN}{}{CLOSE}\nmore context",
            body(&fragment)
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
        let (original_state, corrected_state) = (snapshot_of(&original), snapshot_of(&corrected));
        let update = sent(
            &corrected,
            PreviousWorldStateSection::Known(&original_state),
        )
        .unwrap();
        assert!(body(&update).contains("Corrected default."));
        assert!(!body(&update).contains("Original default."));
        assert_ne!(original_state["revision"], corrected_state["revision"]);

        fs::remove_file(&path).unwrap();
        let absent = context.capture();
        let absent_state = snapshot_of(&absent);
        let withdrawal = sent(&absent, PreviousWorldStateSection::Known(&corrected_state)).unwrap();
        assert!(body(&withdrawal).contains("Withdraw prior defaults for this project/source only"));
        assert_eq!(absent_state["state"], "empty");

        fs::write(
            &path,
            "## Project preferences\nOne\n## Project preferences\nTwo\n",
        )
        .unwrap();
        let unavailable = context.capture();
        let unavailable_state = snapshot_of(&unavailable);
        let notice = sent(
            &unavailable,
            PreviousWorldStateSection::Known(&absent_state),
        )
        .unwrap();
        assert!(body(&notice).contains("not a removal or a new revision"));
        assert!(unavailable_state.get("revision").is_none());
        // This is the null-free shape Codex persists, so it suppresses unchanged notices.
        assert!(
            sent(
                &unavailable,
                PreviousWorldStateSection::Known(&unavailable_state)
            )
            .is_none()
        );
        assert!(sent(&unavailable, PreviousWorldStateSection::Unknown).is_some());
        write(workspace.path(), "Corrected default.");
        assert!(
            sent(
                &context.capture(),
                PreviousWorldStateSection::Known(&unavailable_state)
            )
            .is_some()
        );
    }

    #[test]
    fn registry_only_adds_preferences_for_an_explicit_project_scope() {
        use super::super::{RunInstructions, TurnStartTokenUsage, codex_extension_registry};
        use crate::required_execution::RequiredExecutionGate;

        let usage = TurnStartTokenUsage::default();
        let gate = RequiredExecutionGate::default();
        let run = RunInstructions::default();
        // The run's own instructions are always there; preferences only with a project.
        assert_eq!(
            codex_extension_registry(&usage, &gate, &run, None)
                .context_contributors()
                .len(),
            1
        );
        let workspace = tempfile::tempdir().unwrap();
        assert_eq!(
            codex_extension_registry(
                &usage,
                &gate,
                &run,
                Some((Uuid::new_v4(), workspace.path()))
            )
            .context_contributors()
            .len(),
            2
        );
    }
}
