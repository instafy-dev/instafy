//! The out-of-process V8 host that code-mode models run their tools in.
//!
//! Upstream Codex removed its in-process V8 runtime (rust-v0.159), so a model
//! whose catalog entry is `code_mode_only` (gpt-6-luna, gpt-5.6-sol) cannot call
//! any tool without `codex-code-mode-host`. Runtime images and desktop builds
//! install it next to the runtime-agent binary. Runtime-agent points Codex at
//! exactly that file and refuses to start a turn that needs a missing host.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use codex_code_mode::{CodeModeSessionProvider, ProcessOwnedCodeModeSessionProvider};
use codex_core::config::Config;
use codex_features::Feature;
use codex_protocol::openai_models::{ModelInfo, ToolMode};

pub const EXECUTABLE_NAME: &str = if cfg!(windows) {
    "codex-code-mode-host.exe"
} else {
    "codex-code-mode-host"
};

/// `dirname(current_exe)/codex-code-mode-host`.
pub fn host_program() -> Result<PathBuf> {
    let executable =
        std::env::current_exe().context("failed to resolve the runtime-agent executable")?;
    host_program_beside(&executable)
}

fn host_program_beside(executable: &Path) -> Result<PathBuf> {
    let directory = executable.parent().with_context(|| {
        format!(
            "runtime-agent executable {} has no parent directory",
            executable.display()
        )
    })?;
    Ok(directory.join(EXECUTABLE_NAME))
}

/// Whether Codex fails the model's tools closed without the host. A plain code
/// mode model falls back to direct tools unless the config forbids it.
pub(crate) fn model_requires_host(model_info: &ModelInfo, config: &Config) -> bool {
    let fallback_forbidden = config.code_mode.disable_in_process_fallback;
    match model_info.tool_mode {
        Some(ToolMode::CodeModeOnly) => true,
        Some(ToolMode::CodeMode) => fallback_forbidden,
        Some(ToolMode::Direct) => false,
        None if config.features.enabled(Feature::CodeModeOnly) => true,
        None => config.features.enabled(Feature::CodeMode) && fallback_forbidden,
    }
}

/// Fails before the turn starts, with a message that names the missing file,
/// instead of letting every tool call of the turn fail inside Codex.
pub(crate) fn ensure_host_for_model(
    host: &Path,
    model_info: &ModelInfo,
    config: &Config,
) -> Result<()> {
    if host.is_file() || !model_requires_host(model_info, config) {
        return Ok(());
    }
    bail!(
        "Codex model `{}` runs its tools only through code mode, but the code-mode host is missing at {}. Install `{EXECUTABLE_NAME}` next to runtime-agent; runtime images and desktop builds ship it.",
        model_info.slug,
        host.display()
    )
}

/// Whether Codex's bundled catalog marks `slug` code-mode-only, so it cannot run any tool
/// without the host. Test harnesses use it to fail loudly when the host was not built.
pub fn bundled_model_is_code_mode_only(slug: &str) -> Result<bool> {
    let catalog = codex_models_manager::bundled_models_response()
        .context("failed to load the bundled Codex model catalog")?;
    Ok(catalog
        .models
        .iter()
        .any(|model| model.slug == slug && model.tool_mode == Some(ToolMode::CodeModeOnly)))
}

/// The provider a thread manager uses, bound to the checked host path.
pub(crate) fn session_provider(host: PathBuf) -> Arc<dyn CodeModeSessionProvider> {
    Arc::new(ProcessOwnedCodeModeSessionProvider::with_host_program(host))
}

/// Start-up report: an image or desktop build that lost the host still starts,
/// because models without code mode work, but it says so once, loudly.
pub fn report_startup_availability() {
    match host_program() {
        Ok(host) if host.is_file() => {
            tracing::info!(host = %host.display(), "Codex code-mode host is available");
        }
        Ok(host) => tracing::error!(
            host = %host.display(),
            "Codex code-mode host is missing; turns on code-mode-only models (gpt-6-luna, gpt-5.6-sol) will be refused"
        ),
        Err(error) => tracing::error!(
            error = %error,
            "failed to locate the Codex code-mode host; turns on code-mode-only models will be refused"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_core::config::{ConfigBuilder, ConfigOverrides};
    use codex_core::test_support::construct_model_info_offline;

    async fn policy_config(model: &str) -> (tempfile::TempDir, Config) {
        let home = tempfile::tempdir().expect("codex home");
        let mut config = ConfigBuilder::default()
            .codex_home(home.path().to_path_buf())
            .harness_overrides(ConfigOverrides {
                model: Some(model.to_string()),
                cwd: Some(home.path().to_path_buf()),
                ..Default::default()
            })
            .build()
            .await
            .expect("load Codex config");
        crate::codex_policy::apply_runtime_codex_policy(&mut config, false).expect("policy");
        (home, config)
    }

    #[test]
    fn host_is_expected_next_to_the_runtime_agent_binary() {
        let host = host_program_beside(Path::new("/usr/local/bin/runtime-agent")).unwrap();
        assert_eq!(
            host,
            Path::new("/usr/local/bin").join(EXECUTABLE_NAME),
            "Dockerfile and desktop packaging install the host beside runtime-agent"
        );
        assert!(
            host_program()
                .unwrap()
                .ends_with(Path::new(EXECUTABLE_NAME))
        );
    }

    #[tokio::test]
    async fn code_mode_only_models_fail_closed_without_the_host() {
        let missing = tempfile::tempdir().expect("tempdir");
        let missing_host = missing.path().join(EXECUTABLE_NAME);
        for model in ["gpt-6-luna", "gpt-5.6-sol"] {
            let (_home, config) = policy_config(model).await;
            let model_info = construct_model_info_offline(model, &config);
            assert!(model_requires_host(&model_info, &config), "{model}");
            let error = ensure_host_for_model(&missing_host, &model_info, &config)
                .expect_err("a code-mode-only model must not start without the host")
                .to_string();
            assert!(error.contains(model), "{error}");
            assert!(
                error.contains(&missing_host.display().to_string()),
                "{error}"
            );
            assert!(error.contains("code-mode host is missing"), "{error}");

            std::fs::write(&missing_host, b"").expect("host placeholder");
            ensure_host_for_model(&missing_host, &model_info, &config)
                .expect("an installed host lets the turn start");
            std::fs::remove_file(&missing_host).expect("remove placeholder");
        }
    }

    #[test]
    fn the_bundled_catalog_names_the_code_mode_only_models() {
        for model in ["gpt-6-luna", "gpt-5.6-sol"] {
            assert!(bundled_model_is_code_mode_only(model).unwrap(), "{model}");
        }
        for model in ["gpt-5.5", "not-a-catalog-model"] {
            assert!(!bundled_model_is_code_mode_only(model).unwrap(), "{model}");
        }
    }

    #[tokio::test]
    async fn direct_tool_models_do_not_need_the_host() {
        let missing = tempfile::tempdir().expect("tempdir");
        let (_home, config) = policy_config("gpt-5.5").await;
        let model_info = construct_model_info_offline("gpt-5.5", &config);
        assert!(!model_requires_host(&model_info, &config));
        ensure_host_for_model(&missing.path().join(EXECUTABLE_NAME), &model_info, &config)
            .expect("gpt-5.5 keeps direct tools");
    }
}
