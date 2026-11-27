use serde::Deserialize;

/// Tells a PATCH body's absent field (keep) from its `null` (clear): with
/// `#[serde(default, deserialize_with = "double_option")]` on an
/// `Option<Option<T>>`, a present null becomes `Some(None)`. Serde's own
/// handling of the nested option maps both to the outer `None`, which made
/// every nullable clear a silent no-op.
pub(crate) fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

pub(crate) fn coerce_idle_ttl(input: Option<u32>) -> u32 {
    #[cfg(debug_assertions)]
    const MIN_TTL: u32 = 10;
    #[cfg(not(debug_assertions))]
    const MIN_TTL: u32 = 300;

    #[cfg(debug_assertions)]
    const DEFAULT_TTL: u32 = 30;
    #[cfg(not(debug_assertions))]
    const DEFAULT_TTL: u32 = 3600;

    input
        .filter(|value| *value >= MIN_TTL)
        .unwrap_or(DEFAULT_TTL)
}
