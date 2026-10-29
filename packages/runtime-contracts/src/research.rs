//! Bounds for controller-owned, task-wide web research budgets.
use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_PAGE_LOADS: u32 = 12;
pub const DEFAULT_MAX_PAGE_LOADS_PER_SITE: u32 = 4;
pub const MAX_PAGE_LOADS: u32 = 200;
pub const RESEARCH_RESERVE_SCOPE: &str = "research.reserve";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ResearchSettingsWire", into = "ResearchSettingsWire")]
pub struct ResearchSettings {
    pub max_page_loads: u32,
    pub max_page_loads_per_site: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResearchSettingsWire {
    max_page_loads: u32,
    max_page_loads_per_site: u32,
}

impl Default for ResearchSettings {
    fn default() -> Self {
        Self {
            max_page_loads: DEFAULT_MAX_PAGE_LOADS,
            max_page_loads_per_site: DEFAULT_MAX_PAGE_LOADS_PER_SITE,
        }
    }
}

impl ResearchSettings {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !(1..=MAX_PAGE_LOADS).contains(&self.max_page_loads) {
            return Err("maxPageLoads must be an integer between 1 and 200");
        }
        if !(1..=self.max_page_loads).contains(&self.max_page_loads_per_site) {
            return Err("maxPageLoadsPerSite must be between 1 and maxPageLoads");
        }
        Ok(self)
    }
}

impl TryFrom<ResearchSettingsWire> for ResearchSettings {
    type Error = &'static str;
    fn try_from(value: ResearchSettingsWire) -> Result<Self, Self::Error> {
        Self {
            max_page_loads: value.max_page_loads,
            max_page_loads_per_site: value.max_page_loads_per_site,
        }
        .validate()
    }
}
impl From<ResearchSettings> for ResearchSettingsWire {
    fn from(value: ResearchSettings) -> Self {
        Self {
            max_page_loads: value.max_page_loads,
            max_page_loads_per_site: value.max_page_loads_per_site,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn research_settings_validate_at_the_transport_boundary() {
        assert_eq!(
            serde_json::from_str::<ResearchSettings>(
                r#"{"maxPageLoads":12,"maxPageLoadsPerSite":4}"#
            )
            .unwrap(),
            ResearchSettings::default()
        );
        for value in [
            r#"{"maxPageLoads":0,"maxPageLoadsPerSite":4}"#,
            r#"{"maxPageLoads":201,"maxPageLoadsPerSite":4}"#,
            r#"{"maxPageLoads":4,"maxPageLoadsPerSite":5}"#,
            r#"{"maxPageLoads":4,"maxPageLoadsPerSite":0}"#,
        ] {
            assert!(serde_json::from_str::<ResearchSettings>(value).is_err());
        }
    }
}
