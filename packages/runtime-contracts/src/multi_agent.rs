//! Shared bounds for controller-owned team execution settings.

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_AGENTS_PER_PLAN: u32 = 64;
pub const MAX_AGENTS_PER_PLAN: u32 = 256;
pub const DEFAULT_MAX_CONCURRENT_AGENTS: u32 = 8;
pub const MAX_CONCURRENT_AGENTS: u32 = 64;
pub const DEFAULT_MAX_NATIVE_SUBAGENTS: u32 = 3;
pub const MAX_NATIVE_SUBAGENTS: u32 = 64;

/// Native helpers per parent job, excluding the parent itself. This is independent
/// of the space-wide admission limit for controller-tracked workers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
pub struct NativeSubagentLimit(u32);

impl NativeSubagentLimit {
    pub const MIN: Self = Self(1);

    pub fn get(self) -> u32 {
        self.0
    }
}

impl Default for NativeSubagentLimit {
    fn default() -> Self {
        Self(DEFAULT_MAX_NATIVE_SUBAGENTS)
    }
}

impl TryFrom<u32> for NativeSubagentLimit {
    type Error = &'static str;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        if !(Self::MIN.get()..=MAX_NATIVE_SUBAGENTS).contains(&value) {
            return Err("maxNativeSubagents must be an integer between 1 and 64");
        }
        Ok(Self(value))
    }
}

impl From<NativeSubagentLimit> for u32 {
    fn from(value: NativeSubagentLimit) -> Self {
        value.get()
    }
}

/// Controller-resolved execution settings delivered separately from user-authored
/// prompts and granted environment variables to the runtime owning a live job.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeSettings {
    #[serde(default)]
    pub max_native_subagents: NativeSubagentLimit,
    /// Presence requires the runtime to use the controller-shared budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_budget: Option<crate::research::ResearchSettings>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultiAgentSettings {
    pub max_agents_per_plan: u32,
    pub max_concurrent_agents: u32,
    #[serde(default = "default_max_native_subagents")]
    pub max_native_subagents: u32,
}

fn default_max_native_subagents() -> u32 {
    DEFAULT_MAX_NATIVE_SUBAGENTS
}

impl Default for MultiAgentSettings {
    fn default() -> Self {
        Self {
            max_agents_per_plan: DEFAULT_MAX_AGENTS_PER_PLAN,
            max_concurrent_agents: DEFAULT_MAX_CONCURRENT_AGENTS,
            max_native_subagents: DEFAULT_MAX_NATIVE_SUBAGENTS,
        }
    }
}

impl MultiAgentSettings {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !(1..=MAX_AGENTS_PER_PLAN).contains(&self.max_agents_per_plan) {
            return Err("maxAgentsPerPlan must be an integer between 1 and 256");
        }
        if !(1..=MAX_CONCURRENT_AGENTS).contains(&self.max_concurrent_agents) {
            return Err("maxConcurrentAgents must be an integer between 1 and 64");
        }
        NativeSubagentLimit::try_from(self.max_native_subagents)?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_helper_limits_preserve_legacy_defaults_and_validate_wire_values() {
        let legacy: MultiAgentSettings = serde_json::from_value(json!({
            "maxAgentsPerPlan": 64,
            "maxConcurrentAgents": 8
        }))
        .unwrap();
        assert_eq!(legacy, MultiAgentSettings::default());
        assert_eq!(
            AgentRuntimeSettings::default().max_native_subagents.get(),
            3
        );
        assert_eq!(
            serde_json::from_value::<AgentRuntimeSettings>(json!({})).unwrap(),
            AgentRuntimeSettings::default()
        );
        for value in [1, 10, 64] {
            let settings: AgentRuntimeSettings =
                serde_json::from_value(json!({"maxNativeSubagents": value})).unwrap();
            assert_eq!(settings.max_native_subagents.get(), value);
            assert_eq!(
                serde_json::to_value(settings).unwrap(),
                json!({"maxNativeSubagents": value})
            );
        }
        for value in [
            json!(0),
            json!(65),
            json!(-1),
            json!(1.5),
            json!("10"),
            json!(null),
        ] {
            assert!(serde_json::from_value::<AgentRuntimeSettings>(
                json!({"maxNativeSubagents": value})
            )
            .is_err());
        }
    }
}
