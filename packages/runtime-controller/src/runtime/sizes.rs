//! Hosted runtime size catalog.
//!
//! Deliberately a two-entry catalog, not a matrix: one honest default and one
//! "Boost" for projects that hit the 4 GB wall. Sizes are validated
//! server-side and the resource-limit envs are always derived here — client
//! metadata must never set RUNTIME_CPU_LIMIT/RUNTIME_MEMORY_LIMIT directly
//! (that would be free compute).

use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RuntimeSize {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    /// docker compose `cpus` value.
    pub(crate) cpus: &'static str,
    /// docker compose `mem_limit` value.
    pub(crate) memory: &'static str,
    pub(crate) cpu_count: f64,
    pub(crate) memory_gb: f64,
    /// Multiplier applied to the provider's per-bucket credit burn.
    pub(crate) burn_multiplier: f64,
}

pub(crate) const RUNTIME_SIZES: &[RuntimeSize] = &[
    RuntimeSize {
        id: "standard",
        label: "Standard",
        cpus: "2",
        memory: "4g",
        cpu_count: 2.0,
        memory_gb: 4.0,
        burn_multiplier: 1.0,
    },
    RuntimeSize {
        id: "boost",
        label: "Boost",
        cpus: "4",
        memory: "8g",
        cpu_count: 4.0,
        memory_gb: 8.0,
        burn_multiplier: 2.0,
    },
];

pub(crate) fn default_runtime_size() -> &'static RuntimeSize {
    &RUNTIME_SIZES[0]
}

/// Unknown or missing ids resolve to the default size — a stale client can
/// never brick provisioning or grant itself an unpriced size.
pub(crate) fn resolve_runtime_size(id: Option<&str>) -> &'static RuntimeSize {
    let Some(id) = id.map(str::trim).filter(|value| !value.is_empty()) else {
        return default_runtime_size();
    };
    RUNTIME_SIZES
        .iter()
        .find(|size| size.id.eq_ignore_ascii_case(id))
        .unwrap_or_else(|| default_runtime_size())
}

pub(crate) fn size_from_metadata(metadata: &Option<JsonValue>) -> &'static RuntimeSize {
    let id = metadata
        .as_ref()
        .and_then(|value| value.get("sizeId"))
        .and_then(JsonValue::as_str);
    resolve_runtime_size(id)
}

/// Scales a per-bucket burn amount by the size multiplier (rounded up so a
/// boosted runtime never bills less than its share).
pub(crate) fn scaled_burn_amount(base_amount: i32, size: &RuntimeSize) -> i32 {
    if base_amount <= 0 {
        return base_amount.max(0);
    }
    ((f64::from(base_amount) * size.burn_multiplier).ceil() as i64).clamp(0, i64::from(i32::MAX))
        as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_unknown_and_missing_sizes() {
        assert_eq!(resolve_runtime_size(Some("boost")).id, "boost");
        assert_eq!(resolve_runtime_size(Some("BOOST")).id, "boost");
        assert_eq!(resolve_runtime_size(Some("mega")).id, "standard");
        assert_eq!(resolve_runtime_size(None).id, "standard");
        assert_eq!(resolve_runtime_size(Some("  ")).id, "standard");
    }

    #[test]
    fn scales_burn_amounts_with_ceiling() {
        let boost = resolve_runtime_size(Some("boost"));
        assert_eq!(scaled_burn_amount(13, boost), 26);
        assert_eq!(scaled_burn_amount(13, default_runtime_size()), 13);
        assert_eq!(scaled_burn_amount(0, boost), 0);
    }
}
