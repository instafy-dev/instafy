//! Which model a sequential job asks the proxy for, and the launch model.
//!
//! Parallel and isolated scoped workers never install secrets into the
//! process environment: they take their model and effort from
//! `agent::resolved_worker_job_config`, and fall back to [`launch_model`].
//!
//! The controller owns model choice: every AI job's secrets carry
//! `CODEX_MODEL` (the managed default, the agent's model or the credential's
//! default). The runtime only falls back when a job arrives without one, and
//! says so in the log, because a fallback is how stale ids reach the proxy:
//! a dev launcher or `.env` template that pins an old model would otherwise
//! silently override the controller on every lane that skipped job secrets.
//!
//! Order: the job's model, else the `CODEX_MODEL` the runtime was launched
//! with (captured once at startup and then removed from the process
//! environment, so nothing reads it implicitly), else [`DEFAULT_CODEX_MODEL`].
//! Retired ids are raised to the default in every case.

use std::sync::OnceLock;

use runtime_contracts::own_ai_model::is_retired_openai_model;

/// Built-in last resort, used only when neither the job nor the launch
/// environment names a model: the controller's own-AI default, from the
/// contract both read.
pub(crate) use runtime_contracts::own_ai_model::OWN_AI_DEFAULT_MODEL_ID as DEFAULT_CODEX_MODEL;

pub(crate) const MODEL_ENV_KEY: &str = "CODEX_MODEL";
pub(crate) const MODEL_PROVIDER_ENV_KEY: &str = "CODEX_MODEL_PROVIDER";

#[derive(Debug, Default)]
struct LaunchModel {
    model: Option<String>,
    provider: Option<String>,
}

static LAUNCH_MODEL: OnceLock<LaunchModel> = OnceLock::new();

/// Capture the launch-time `CODEX_MODEL` / `CODEX_MODEL_PROVIDER` and remove
/// them from the process environment. After this, a `CODEX_MODEL` in the
/// process environment can only be one a job's secrets installed.
///
/// # Safety
/// Call before any other thread exists (it mutates the process environment).
pub unsafe fn capture_and_scrub_launch_model() {
    let launch = LaunchModel {
        model: non_empty(std::env::var(MODEL_ENV_KEY).ok().as_deref()),
        provider: non_empty(std::env::var(MODEL_PROVIDER_ENV_KEY).ok().as_deref()),
    };
    let _ = LAUNCH_MODEL.set(launch);
    for key in [MODEL_ENV_KEY, MODEL_PROVIDER_ENV_KEY] {
        // SAFETY: the caller guarantees no concurrent environment access.
        unsafe { std::env::remove_var(key) };
    }
}

pub(crate) fn launch_model() -> Option<&'static str> {
    LAUNCH_MODEL
        .get()
        .and_then(|launch| launch.model.as_deref())
}

pub(crate) fn launch_model_provider() -> Option<&'static str> {
    LAUNCH_MODEL
        .get()
        .and_then(|launch| launch.provider.as_deref())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelSource {
    Job,
    Launch,
    Default,
}

impl ModelSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Job => "job",
            Self::Launch => "launch env",
            Self::Default => "built-in default",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedModel {
    pub id: String,
    pub source: ModelSource,
}

/// Resolve a model from an explicit job value and launch value. Logs a WARN
/// whenever the job carried no model, naming where the fallback came from.
pub(crate) fn resolve_model(
    job_model: Option<&str>,
    launch_model: Option<&str>,
    lane: &str,
) -> ResolvedModel {
    let (raw, source) = match (non_empty(job_model), non_empty(launch_model)) {
        (Some(model), _) => (model, ModelSource::Job),
        (None, Some(model)) => (model, ModelSource::Launch),
        (None, None) => (DEFAULT_CODEX_MODEL.to_string(), ModelSource::Default),
    };
    if source != ModelSource::Job {
        tracing::warn!(
            lane,
            model = %raw,
            source = source.as_str(),
            "job carried no model from the controller; falling back"
        );
    }
    let id = normalize_model_id(&raw);
    if id != raw {
        tracing::warn!(lane, from_model = %raw, to_model = %id, "raised a retired model id");
    }
    ResolvedModel { id, source }
}

/// The model for a sequential job whose secrets were installed into the
/// process environment (`apply_job_secrets`).
pub(crate) fn resolve_for_installed_job(lane: &str) -> ResolvedModel {
    resolve_model(
        std::env::var(MODEL_ENV_KEY).ok().as_deref(),
        launch_model(),
        lane,
    )
}

/// The Codex turn override for an installed job: the job's or the launch
/// model, or `None` so Codex's own configuration (then the runtime default)
/// applies. A missing job model is logged either way.
pub(crate) fn installed_job_model_override(lane: &str) -> Option<String> {
    let resolved = resolve_for_installed_job(lane);
    (resolved.source != ModelSource::Default).then_some(resolved.id)
}

/// Provider id for an installed sequential job, else the launch value.
pub(crate) fn installed_job_model_provider() -> Option<String> {
    non_empty(std::env::var(MODEL_PROVIDER_ENV_KEY).ok().as_deref())
        .or_else(|| launch_model_provider().map(str::to_string))
}

/// Retired ids (and empty) become [`DEFAULT_CODEX_MODEL`]. Only ids that are
/// no longer served are raised here; the controller's own-AI floor
/// (`runtime_contracts::own_ai_model::own_ai_model_floor`) is applied before a
/// job arrives, and an operator's served managed model below the own-AI
/// default must keep the tools of the model the proxy pins.
pub(crate) fn normalize_model_id(model: &str) -> String {
    match model.trim() {
        "" => DEFAULT_CODEX_MODEL.to_string(),
        trimmed if is_retired_openai_model(trimmed) => DEFAULT_CODEX_MODEL.to_string(),
        trimmed => trimmed.to_string(),
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_jobs_model_wins_over_a_stale_launch_value() {
        let resolved = resolve_model(Some("gpt-6-luna"), Some("gpt-5.5"), "test");
        assert_eq!(resolved.id, "gpt-6-luna");
        assert_eq!(resolved.source, ModelSource::Job);
    }

    #[test]
    fn a_job_without_a_model_falls_back_to_launch_then_default_and_says_so() {
        let launch = resolve_model(Some("  "), Some("gpt-6-luna"), "test");
        assert_eq!(launch.id, "gpt-6-luna");
        assert_eq!(launch.source, ModelSource::Launch);
        let default = resolve_model(None, None, "test");
        assert_eq!(default.id, DEFAULT_CODEX_MODEL);
        assert_eq!(default.source, ModelSource::Default);
    }

    #[test]
    fn retired_ids_are_raised_from_any_source() {
        for retired in [
            "gpt-5-codex",
            "gpt-5.2",
            "gpt-5.3-codex",
            "gpt-5.4",
            "gpt-5.4-mini",
            // Retired by the controller already; the runtime now agrees.
            "gpt-4o",
            "o3-mini",
        ] {
            assert_eq!(
                resolve_model(Some(retired), None, "t").id,
                DEFAULT_CODEX_MODEL
            );
            assert_eq!(
                resolve_model(None, Some(retired), "t").id,
                DEFAULT_CODEX_MODEL
            );
        }
        assert_eq!(normalize_model_id("gpt-6-luna"), "gpt-6-luna");
        assert_eq!(normalize_model_id("deepseek-chat"), "deepseek-chat");
        // Served ids below GPT-6 run as sent: an operator's managed model is
        // the one the proxy pins.
        assert_eq!(normalize_model_id("gpt-5.5"), "gpt-5.5");
        assert_eq!(normalize_model_id("gpt-5.6-luna"), "gpt-5.6-luna");
    }
}
