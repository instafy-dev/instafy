//! Shared bounds for controller-owned team execution settings.

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_AGENTS_PER_PLAN: u32 = 64;
pub const MAX_AGENTS_PER_PLAN: u32 = 256;
pub const DEFAULT_MAX_CONCURRENT_AGENTS: u32 = 8;
pub const MAX_CONCURRENT_AGENTS: u32 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultiAgentSettings {
    pub max_agents_per_plan: u32,
    pub max_concurrent_agents: u32,
}

impl Default for MultiAgentSettings {
    fn default() -> Self {
        Self {
            max_agents_per_plan: DEFAULT_MAX_AGENTS_PER_PLAN,
            max_concurrent_agents: DEFAULT_MAX_CONCURRENT_AGENTS,
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
        Ok(self)
    }
}
