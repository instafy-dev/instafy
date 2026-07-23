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
