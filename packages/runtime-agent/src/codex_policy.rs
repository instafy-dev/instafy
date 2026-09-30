//! Instafy's pins on the embedded Codex engine.
//!
//! Every runtime run applies this policy to its loaded Codex `Config` before a
//! thread manager or thread sees it. It keeps billing fixed across Codex bumps
//! (no paid service tier, a 272k context window), blocks experimental tools the
//! runtime cannot deliver, appends Instafy's safety rules to the instructions of
//! every lane, and sets every Codex feature through one exhaustive match, so a
//! new upstream feature fails the build until someone decides its value.

use anyhow::{Context, Result, bail};
use codex_core::config::{Config, ManagedFeatures};
use codex_features::{FEATURES, Feature};
use codex_protocol::openai_models::{ModelInfo, ModelsResponse};

/// The largest context window Instafy bills for. Upstream's catalog lets some
/// models grow to 872k tokens on request; runtime turns never do.
pub(crate) const MAX_BILLED_CONTEXT_WINDOW: i64 = 272_000;

/// Experimental model tools the runtime cannot deliver. Async user messages and
/// questions would reach nobody in a background job, and `clock` (with its
/// sleep tool) lets a turn idle while it holds a runtime lease.
pub(crate) const BLOCKED_MODEL_TOOLS: &[&str] = &[
    "send_user_message_async",
    "request_user_input_async",
    // Newer name for the same async user-messaging capability.
    "send_message_to_user_async",
    "clock",
];

const RUNTIME_SAFETY_RULES: &str = include_str!("codex_runtime_safety_rules.md");

/// Instafy's "File editing constraints" and "Destructive Actions" sections,
/// kept verbatim from the GPT-6 prompt the runtime shipped before
/// rust-v0.159.2 (instafy-dev/codex 99f24c873). Upstream's prompt dropped them.
pub(crate) fn runtime_safety_rules() -> &'static str {
    RUNTIME_SAFETY_RULES.trim_end()
}

/// Applies the runtime policy to a freshly loaded Codex configuration.
///
/// `bounded_browser` marks a Shared or Personal Browser turn, which may only use
/// its browser MCP server.
pub(crate) fn apply_runtime_codex_policy(config: &mut Config, bounded_browser: bool) -> Result<()> {
    // Billing: never request a paid service tier. Codex does not apply a model's
    // default tier on its own; FastMode (below) is the other way to select one.
    config.service_tier = None;

    // Billing: pin the effective window whether or not a config file chose one.
    // Codex applies it on top of the catalog entry, clamped to the entry's max.
    config.model_context_window = Some(
        config
            .model_context_window
            .map_or(MAX_BILLED_CONTEXT_WINDOW, |window| {
                window.min(MAX_BILLED_CONTEXT_WINDOW)
            }),
    );
    config.model_auto_compact_token_limit = config
        .model_auto_compact_token_limit
        .map(|limit| limit.min(MAX_BILLED_CONTEXT_WINDOW));

    let mut catalog = match config.model_catalog.take() {
        Some(catalog) => catalog,
        None => codex_models_manager::bundled_models_response()
            .context("failed to load the bundled Codex model catalog")?,
    };
    apply_model_catalog_policy(&mut catalog);
    config.model_catalog = Some(catalog);

    // Lanes with their own base instructions replace the model prompt entirely,
    // so they carry the safety rules themselves.
    if let Some(instructions) = config.base_instructions.as_mut() {
        append_runtime_safety_rules(instructions);
    }

    // Model traffic uses only the configured provider route (the Instafy proxy).
    config.respect_system_proxy = false;

    if bounded_browser {
        // A model whose catalog entry selects multi-agent v2 (gpt-6-luna) gets the child-agent
        // tools even with the Collab and MultiAgentV2 features off; only `[agents]` disables them.
        config.agents_enabled = false;
    }

    apply_feature_policy(&mut config.features, bounded_browser)
}

/// Applies the catalog part of the policy to every model the run could select,
/// including subagents that switch models.
fn apply_model_catalog_policy(catalog: &mut ModelsResponse) {
    for model in &mut catalog.models {
        for window in [&mut model.context_window, &mut model.max_context_window] {
            if let Some(window) = window.as_mut() {
                *window = (*window).min(MAX_BILLED_CONTEXT_WINDOW);
            }
        }
        // Codex derives the auto-compact limit from the window above; clamp an
        // explicit one too so no entry names a limit beyond it.
        if let Some(limit) = model.auto_compact_token_limit.as_mut() {
            *limit = (*limit).min(MAX_BILLED_CONTEXT_WINDOW);
        }
        model.default_service_tier = None;
        model
            .experimental_supported_tools
            .retain(|tool| !BLOCKED_MODEL_TOOLS.contains(&tool.as_str()));
        let template = model
            .model_messages
            .get_or_insert_default()
            .instructions_template
            .get_or_insert_default();
        append_runtime_safety_rules(template);
    }
}

/// Makes sure a lane that uses the model's own prompt carries the safety rules
/// even when the model resolved to Codex's fallback metadata, which does not
/// come from the catalog. Call with the model info Codex resolved for `config`.
pub(crate) fn pin_instructions_for_resolved_model(config: &mut Config, model_info: &ModelInfo) {
    if config.base_instructions.is_some() {
        return;
    }
    let template = model_info
        .model_messages
        .as_ref()
        .and_then(|messages| messages.instructions_template.as_deref())
        .unwrap_or_default();
    if template.contains(runtime_safety_rules()) {
        return;
    }
    let mut instructions = template.to_string();
    append_runtime_safety_rules(&mut instructions);
    config.base_instructions = Some(instructions);
}

fn append_runtime_safety_rules(instructions: &mut String) {
    let rules = runtime_safety_rules();
    if instructions.contains(rules) {
        return;
    }
    let trimmed = instructions.trim_end().len();
    instructions.truncate(trimmed);
    if !instructions.is_empty() {
        instructions.push_str("\n\n");
    }
    instructions.push_str(rules);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FeaturePin {
    /// Keep the value Codex resolved from its defaults and config.
    Upstream,
    /// On for every runtime turn.
    On,
    /// Off for every runtime turn.
    Off,
    /// Off for Shared and Personal Browser turns. Page content is untrusted, so
    /// it must not reach local files, child agents, another network tool,
    /// plugins, or image generation through prompt injection.
    OffInBoundedBrowser,
}

/// Every Codex feature, with no catch-all arm: a feature added upstream fails
/// the build until its runtime value is chosen here.
fn feature_pin(feature: Feature) -> FeaturePin {
    use FeaturePin::{Off, OffInBoundedBrowser, On, Upstream};
    match feature {
        // Billing: Fast mode selects the paid priority tier.
        Feature::FastMode => Off,
        // A sleeping turn idles while it holds a runtime lease.
        Feature::SleepTool => Off,
        // Model traffic uses only the configured provider route.
        Feature::RespectSystemProxy | Feature::SystemProxyFallback => Off,
        // Shell snapshots replay exported env vars, including job credentials,
        // into files under CODEX_HOME.
        Feature::ShellSnapshot => Off,
        // Runtime jobs carry their own instructions; kept off although upstream
        // retired the flag.
        Feature::Personality => Off,
        // These would re-expose the blocked async-message and clock tools.
        Feature::SendMessageToUserAsync | Feature::CurrentTimeReminder => Off,
        // Upstream retries a refused or dropped connection forever (5s to 60s backoff), ignoring
        // the bounded proxy retry budget; an unreachable proxy would hold the job's lease until
        // the run timeout instead of failing with the connection error.
        Feature::UnboundedConnectionRetries => Off,

        // Upstream removed the in-process V8 runtime, so code-mode-only models
        // (gpt-6-luna, gpt-5.6-sol) run every tool through this host.
        Feature::CodeModeHost => On,

        Feature::ShellTool
        | Feature::ShellZshFork
        | Feature::ExecPermissionApprovals
        | Feature::ApplyPatchStreamingEvents
        | Feature::ViewImage
        | Feature::CodeModeOnly
        | Feature::CodeMode
        | Feature::SpawnCsv
        | Feature::MultiAgentV2
        | Feature::Collab
        | Feature::CollaborationModes
        | Feature::StandaloneWebSearch
        | Feature::WebSearchCached
        | Feature::WebSearchRequest
        | Feature::ImageGeneration
        | Feature::ToolSuggest
        | Feature::Apps
        | Feature::Plugins
        | Feature::RequestPermissionsTool
        | Feature::MemoryTool
        | Feature::ExternalAgentMemoryImport
        | Feature::Chronicle
        | Feature::CodexHooks
        | Feature::SkillMcpDependencyInstall
        | Feature::ExecutorCapabilityDiscovery
        | Feature::EnableMcpApps
        | Feature::BrowserUse
        | Feature::BrowserUseFullCdpAccess
        | Feature::BrowserUseExternal
        | Feature::ComputerUse
        | Feature::RemotePlugin
        | Feature::PluginSharing
        | Feature::DefaultModeRequestUserInput
        | Feature::Goals
        | Feature::Artifact
        | Feature::WorkspaceDependencies
        | Feature::ToolCallMcpElicitation
        | Feature::AuthElicitation => OffInBoundedBrowser,

        // Upstream behavior. UnifiedExec is listed here because Codex forces it
        // on; a bounded browser turn has no shell tool because ShellTool is off
        // and the turn selects no execution environment.
        Feature::AnalyticsPlanHistory
        | Feature::ApiKeyModelDiscovery
        | Feature::TranscriptV2
        | Feature::SecretAuthStorage
        | Feature::DaemonAutoStart
        | Feature::ContentItemKinds
        | Feature::ExecutedToolCallMetadata
        | Feature::CodeModePrewarm
        | Feature::CodeModeInterrupt
        | Feature::UnifiedExec
        | Feature::UnifiedExecTty
        | Feature::TerminalVisualizationInstructions
        | Feature::ApplyPatchPreserveLineEndings
        | Feature::WriteStdinApproval
        | Feature::UseLegacyLandlock
        | Feature::PowerShellShellVersion
        | Feature::ShellSnapshotV2
        | Feature::DeferredExecutor
        | Feature::CwdRelativeTurnDiffs
        | Feature::RuntimeMetrics
        | Feature::LocalThreadStoreCompression
        | Feature::BackgroundPaginatedRolloutMigration
        | Feature::EnableRequestCompression
        | Feature::NetworkProxy
        | Feature::Worktrees
        | Feature::DeferMailboxPreemption
        | Feature::InstantInterrupt
        | Feature::AgentMessageBoard
        | Feature::Psp
        | Feature::Mcp20260728
        | Feature::CodexAppsMcp20260728
        | Feature::McpOAuthRefreshCoordination
        | Feature::UseXaa
        | Feature::DeferredToolWorldState
        | Feature::NonPrefixedMcpToolNames
        | Feature::RecommendedPlugins
        | Feature::SkipHostSkillDiscovery
        | Feature::InAppBrowser
        | Feature::InAppChat
        | Feature::InAppDictation
        | Feature::InAppLocalAutomation
        | Feature::InAppUpdates
        | Feature::OmitAppServerNotificationMedia
        | Feature::ImageResizeNotice
        | Feature::UnifiedImageBudget
        | Feature::ConcurrentReasoningSummaries
        | Feature::SkillSearch
        | Feature::MentionsV2
        | Feature::GuardianApproval
        | Feature::GuardianReuseParentCompaction
        | Feature::GuardianEnhancedNodeReplTranscripts
        | Feature::GuardianNodeReplTranscriptImages
        | Feature::GuardianV2
        | Feature::TokenBudget
        | Feature::ContextManagement
        | Feature::RolloutBudget
        | Feature::ReasoningEffortOverride
        | Feature::NonfatalClockReadErrors
        | Feature::BedrockSetupWizard
        | Feature::StepModelSwitching
        | Feature::RealtimeConversation
        | Feature::PreventIdleSleep
        | Feature::CompactionImageBudget
        | Feature::RetainClientDeveloperMessages
        | Feature::UseAgentIdentity
        | Feature::WindowsSandboxService
        | Feature::PreferMxc => Upstream,

        // Retired upstream: Codex keeps these keys only so old configs parse.
        // UnifiedExecZshFork still gates the zsh bridge together with
        // ShellZshFork, which is off wherever it matters.
        Feature::CodeModeBufferedExec
        | Feature::UnifiedExecZshFork
        | Feature::TerminalResizeReflow
        | Feature::LocalThreadStoreSharedCompression
        | Feature::MultiAgentMode
        | Feature::AppsMcpPathOverride
        | Feature::ToolSearch
        | Feature::ToolSearchAlwaysDeferMcpTools
        | Feature::PluginHooks
        | Feature::ExternalMigration
        | Feature::ResizeAllImages
        | Feature::ItemIds
        | Feature::SkillEnvVarDependencyPrompt
        | Feature::SendAsyncMessage
        | Feature::GuardianThreadContext
        | Feature::GuardianExt
        | Feature::RemoteCompactionV2
        | Feature::GhostCommit
        | Feature::JsRepl
        | Feature::JsReplToolsOnly
        | Feature::SearchTool
        | Feature::UseLinuxSandboxBwrap
        | Feature::RequestRule
        | Feature::WindowsSandbox
        | Feature::WindowsSandboxElevated
        | Feature::RemoteModels
        | Feature::CodexGitCommit
        | Feature::Sqlite
        | Feature::ApplyPatchFreeform
        | Feature::UnavailableDummyTools
        | Feature::Steer
        | Feature::RemoteControl
        | Feature::ImageDetailOriginal
        | Feature::TuiAppServer
        | Feature::WorkspaceOwnerUsageNudge
        | Feature::ResponsesWebsockets
        | Feature::ResponsesWebsocketsV2 => Upstream,
    }
}

fn pinned_value(feature: Feature, bounded_browser: bool) -> Option<bool> {
    match feature_pin(feature) {
        FeaturePin::Upstream => None,
        FeaturePin::On => Some(true),
        FeaturePin::Off => Some(false),
        FeaturePin::OffInBoundedBrowser => bounded_browser.then_some(false),
    }
}

/// Sets every pinned feature in one update, so Codex normalizes dependencies
/// once (CodeModeOnly implies CodeMode), then fails closed if a managed
/// requirement or normalization kept any pin from holding.
fn apply_feature_policy(features: &mut ManagedFeatures, bounded_browser: bool) -> Result<()> {
    let mut next = features.get().clone();
    for spec in FEATURES {
        if let Some(enabled) = pinned_value(spec.id, bounded_browser) {
            next.set_enabled(spec.id, enabled);
        }
    }
    features
        .set(next)
        .context("Codex feature requirements conflict with the Instafy runtime policy")?;
    for spec in FEATURES {
        if let Some(enabled) = pinned_value(spec.id, bounded_browser)
            && features.enabled(spec.id) != enabled
        {
            bail!(
                "Codex feature `{}` must be {} for this runtime turn but stays {}",
                spec.key,
                if enabled { "on" } else { "off" },
                if enabled { "off" } else { "on" },
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{RuntimeBaseInstructionsLane, runtime_base_instructions};
    use codex_core::config::{ConfigBuilder, ConfigOverrides};
    use codex_core::test_support::construct_model_info_offline;
    use codex_protocol::openai_models::ToolMode;

    const POLICY_MODELS: &[&str] = &["gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"];

    async fn load_config(
        model: &str,
        base_instructions: Option<String>,
        config_toml: &str,
    ) -> (tempfile::TempDir, Config) {
        let home = tempfile::tempdir().expect("codex home");
        std::fs::write(home.path().join("config.toml"), config_toml).expect("config.toml");
        let config = ConfigBuilder::default()
            .codex_home(home.path().to_path_buf())
            .harness_overrides(ConfigOverrides {
                model: Some(model.to_string()),
                cwd: Some(home.path().to_path_buf()),
                base_instructions,
                ..Default::default()
            })
            .build()
            .await
            .expect("load Codex config");
        (home, config)
    }

    fn upstream_model(slug: &str) -> ModelInfo {
        codex_models_manager::bundled_models_response()
            .expect("bundled catalog")
            .models
            .into_iter()
            .find(|model| model.slug == slug)
            .unwrap_or_else(|| panic!("bundled catalog lists {slug}"))
    }

    fn template(model_info: &ModelInfo) -> &str {
        model_info
            .model_messages
            .as_ref()
            .and_then(|messages| messages.instructions_template.as_deref())
            .unwrap_or_default()
    }

    /// The instructions Codex sends for `config`: its base instructions when a
    /// lane sets them, otherwise the resolved model's prompt.
    fn effective_instructions(config: &Config) -> String {
        let model = config.model.as_deref().expect("model");
        template(&construct_model_info_offline(model, config)).to_string()
    }

    #[test]
    fn safety_rules_are_the_sections_upstream_dropped() {
        let rules = runtime_safety_rules();
        assert!(rules.starts_with("# File editing constraints\n\nUse `apply_patch`"));
        assert!(rules.contains("\n# Destructive Actions\n"));
        assert!(rules.contains("prefer using `mktemp -d`"));
        assert!(rules.contains("Never run commands such as `rm -rf $HOME`"));
        assert!(rules.ends_with("whether it can be recovered."));
        // Upstream's own GPT-6 prompt no longer carries them, which is why the
        // runtime appends them.
        assert!(!template(&upstream_model("gpt-6-luna")).contains("# Destructive Actions"));
    }

    #[tokio::test]
    async fn every_lane_keeps_upstreams_prompt_or_its_own_and_ends_with_the_safety_rules() {
        let lanes = [
            (
                "ordinary structured",
                RuntimeBaseInstructionsLane::default(),
            ),
            (
                "ordinary plain final",
                RuntimeBaseInstructionsLane {
                    plain_text_final: true,
                    ..Default::default()
                },
            ),
            (
                "ordinary plain write",
                RuntimeBaseInstructionsLane {
                    plain_text_final: true,
                    plain_text_write: true,
                    ..Default::default()
                },
            ),
            // Team plan workers and team planning run the ordinary lanes with a
            // different output schema.
            ("team plan worker", RuntimeBaseInstructionsLane::default()),
            (
                "MCP",
                RuntimeBaseInstructionsLane {
                    mcp: true,
                    ..Default::default()
                },
            ),
            (
                "shared browser",
                RuntimeBaseInstructionsLane {
                    mcp: true,
                    browser: true,
                    ..Default::default()
                },
            ),
            (
                "personal browser",
                RuntimeBaseInstructionsLane {
                    mcp: true,
                    browser: true,
                    ..Default::default()
                },
            ),
        ];
        for model in POLICY_MODELS {
            for (lane_name, lane) in lanes {
                let lane_instructions = runtime_base_instructions(lane, None);
                let (_home, mut config) = load_config(model, lane_instructions.clone(), "").await;
                apply_runtime_codex_policy(&mut config, lane.browser && lane.mcp)
                    .expect("apply runtime policy");
                let resolved = construct_model_info_offline(model, &config);
                pin_instructions_for_resolved_model(&mut config, &resolved);

                let effective = effective_instructions(&config);
                assert!(
                    effective.ends_with(runtime_safety_rules()),
                    "{model} / {lane_name}: safety rules missing"
                );
                assert_eq!(
                    effective.matches("# Destructive Actions").count(),
                    1,
                    "{model} / {lane_name}: safety rules appended more than once"
                );
                let expected_prefix = lane_instructions
                    .unwrap_or_else(|| template(&upstream_model(model)).to_string());
                assert!(
                    effective.starts_with(expected_prefix.trim_end()),
                    "{model} / {lane_name}: lane prompt was replaced"
                );
            }
        }
    }

    #[tokio::test]
    async fn operator_base_instructions_and_unknown_models_also_get_the_safety_rules() {
        let custom = "Operator-provided base instructions.".to_string();
        let lane = RuntimeBaseInstructionsLane::default();
        let (_home, mut config) = load_config(
            "gpt-6-luna",
            runtime_base_instructions(lane, Some(custom.clone())),
            "",
        )
        .await;
        apply_runtime_codex_policy(&mut config, false).expect("policy");
        assert_eq!(
            effective_instructions(&config),
            format!("{custom}\n\n{}", runtime_safety_rules())
        );

        // A model outside the catalog resolves to Codex's fallback prompt, which
        // the catalog policy cannot reach.
        let (_home, mut config) = load_config("byo-provider-model", None, "").await;
        apply_runtime_codex_policy(&mut config, true).expect("policy");
        let resolved = construct_model_info_offline("byo-provider-model", &config);
        assert!(resolved.used_fallback_model_metadata);
        assert!(!template(&resolved).contains(runtime_safety_rules()));
        pin_instructions_for_resolved_model(&mut config, &resolved);
        let effective = effective_instructions(&config);
        assert!(effective.starts_with(template(&resolved).trim_end()));
        assert!(effective.ends_with(runtime_safety_rules()));
    }

    #[tokio::test]
    async fn billing_pins_hold_when_no_context_window_is_configured() {
        for model in POLICY_MODELS {
            let (_home, mut config) = load_config(model, None, "").await;
            assert_eq!(config.model_context_window, None);
            apply_runtime_codex_policy(&mut config, false).expect("policy");
            assert_eq!(config.model_context_window, Some(MAX_BILLED_CONTEXT_WINDOW));
            let resolved = construct_model_info_offline(model, &config);
            let window = resolved.resolved_context_window().expect("window");
            assert!(window <= MAX_BILLED_CONTEXT_WINDOW, "{model}: {window}");
            let compact = resolved.auto_compact_token_limit().expect("auto-compact");
            assert!(compact <= MAX_BILLED_CONTEXT_WINDOW, "{model}: {compact}");
            assert_eq!(resolved.default_service_tier, None, "{model}");
        }
        // Upstream lets GPT-6 Luna grow beyond the billed window.
        assert!(
            upstream_model("gpt-6-luna")
                .max_context_window
                .is_some_and(|window| window > MAX_BILLED_CONTEXT_WINDOW)
        );
    }

    #[tokio::test]
    async fn configured_context_windows_and_service_tiers_cannot_raise_billing() {
        let config_toml = "model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\nservice_tier = \"priority\"\n[features]\nfast_mode = true\n";
        let (_home, mut config) = load_config("gpt-6-luna", None, config_toml).await;
        assert_eq!(config.model_context_window, Some(1_000_000));
        assert!(config.service_tier.is_some());
        assert!(config.features.enabled(Feature::FastMode));
        apply_runtime_codex_policy(&mut config, false).expect("policy");
        assert_eq!(config.model_context_window, Some(MAX_BILLED_CONTEXT_WINDOW));
        assert_eq!(
            config.model_auto_compact_token_limit,
            Some(MAX_BILLED_CONTEXT_WINDOW)
        );
        assert_eq!(config.service_tier, None);
        assert!(!config.features.enabled(Feature::FastMode));
        let resolved = construct_model_info_offline("gpt-6-luna", &config);
        assert_eq!(
            resolved.resolved_context_window(),
            Some(MAX_BILLED_CONTEXT_WINDOW)
        );

        // A smaller configured window is kept.
        let (_home, mut config) =
            load_config("gpt-6-luna", None, "model_context_window = 128000\n").await;
        apply_runtime_codex_policy(&mut config, false).expect("policy");
        assert_eq!(config.model_context_window, Some(128_000));
    }

    #[tokio::test]
    async fn blocked_experimental_tools_leave_every_catalog_model() {
        assert!(
            ["send_user_message_async", "clock"]
                .iter()
                .all(|tool| upstream_model("gpt-6-luna")
                    .experimental_supported_tools
                    .iter()
                    .any(|listed| listed == tool)),
            "upstream GPT-6 Luna no longer advertises the blocked tools; revisit BLOCKED_MODEL_TOOLS"
        );
        let (_home, mut config) = load_config("gpt-6-luna", None, "").await;
        apply_runtime_codex_policy(&mut config, false).expect("policy");
        let catalog = config.model_catalog.as_ref().expect("catalog");
        assert!(!catalog.models.is_empty());
        for model in &catalog.models {
            for tool in &model.experimental_supported_tools {
                assert!(
                    !BLOCKED_MODEL_TOOLS.contains(&tool.as_str()),
                    "{} still advertises {tool}",
                    model.slug
                );
            }
        }
    }

    #[tokio::test]
    async fn upstream_multi_agent_version_and_code_mode_stay_as_shipped() {
        // Owner decision (Sep 30): take upstream's multi-agent v2 for GPT-6 Luna.
        let (_home, mut config) = load_config("gpt-6-luna", None, "").await;
        apply_runtime_codex_policy(&mut config, false).expect("policy");
        for slug in POLICY_MODELS {
            let upstream = upstream_model(slug);
            let resolved = construct_model_info_offline(slug, &config);
            assert_eq!(resolved.multi_agent_version, upstream.multi_agent_version);
            assert_eq!(resolved.tool_mode, upstream.tool_mode);
        }
        assert_eq!(
            construct_model_info_offline("gpt-6-luna", &config).tool_mode,
            Some(ToolMode::CodeModeOnly)
        );
    }

    #[tokio::test]
    async fn feature_pins_hold_on_every_lane_even_against_config_files() {
        let config_toml = "[features]\nsleep_tool = true\nrespect_system_proxy = true\nsystem_proxy_fallback = true\nshell_snapshot = true\nsend_message_to_user_async = true\ncurrent_time_reminder = true\ncode_mode_host = false\nshell_tool = true\napps = true\nunbounded_connection_retries = true\n";
        for bounded_browser in [false, true] {
            let (_home, mut config) = load_config("gpt-6-luna", None, config_toml).await;
            apply_runtime_codex_policy(&mut config, bounded_browser).expect("policy");
            assert!(!config.respect_system_proxy);
            for spec in FEATURES {
                match pinned_value(spec.id, bounded_browser) {
                    Some(enabled) => {
                        assert_eq!(config.features.enabled(spec.id), enabled, "{}", spec.key)
                    }
                    None => {}
                }
            }
            assert!(config.features.enabled(Feature::CodeModeHost));
            assert!(!config.features.enabled(Feature::UnboundedConnectionRetries));
            // Upstream multi-agent v2 stays on ordinary lanes; browser turns get no child agents.
            assert_eq!(config.agents_enabled, !bounded_browser);
            assert_eq!(
                config.features.enabled(Feature::ShellTool),
                !bounded_browser
            );
            assert_eq!(config.features.enabled(Feature::Apps), !bounded_browser);
            // Codex forces unified exec on; a bounded browser turn is kept off
            // shell tools by ShellTool and by selecting no environment.
            assert!(config.features.enabled(Feature::UnifiedExec));
        }
    }

    #[test]
    fn bounded_browser_disables_code_mode_features_but_not_the_host() {
        // CodeModeOnly implies CodeMode, so both must go in one update.
        let mut features = ManagedFeatures::default();
        let mut next = features.get().clone();
        next.enable(Feature::CodeModeOnly);
        next.enable(Feature::CodeMode);
        features.set(next).expect("enable code mode");
        apply_feature_policy(&mut features, true).expect("bounded browser policy");
        assert!(!features.enabled(Feature::CodeModeOnly));
        assert!(!features.enabled(Feature::CodeMode));
        assert!(features.enabled(Feature::CodeModeHost));
        assert!(!features.enabled(Feature::ViewImage));
        assert!(!features.enabled(Feature::SleepTool));
    }

    #[test]
    fn every_listed_feature_has_a_policy() {
        // The exhaustive match already enforces this at compile time; this keeps
        // the forced values visible in test output.
        let forced: Vec<_> = FEATURES
            .iter()
            .filter(|spec| feature_pin(spec.id) != FeaturePin::Upstream)
            .map(|spec| (spec.key, feature_pin(spec.id)))
            .collect();
        for key in [
            "fast_mode",
            "sleep_tool",
            "respect_system_proxy",
            "system_proxy_fallback",
            "shell_snapshot",
            "code_mode_host",
            "shell_tool",
            "view_image",
            "unbounded_connection_retries",
        ] {
            assert!(forced.iter().any(|(forced, _)| *forced == key), "{key}");
        }
    }
}
