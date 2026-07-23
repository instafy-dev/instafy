pub(super) fn normalize_display_name(value: Option<&str>) -> Option<String> {
    value
        .map(|raw| raw.trim())
        .filter(|trimmed| !trimmed.is_empty())
        .map(|trimmed| trimmed.to_string())
}

pub(super) fn normalize_display_name_owned(value: Option<String>) -> Option<String> {
    normalize_display_name(value.as_deref())
}
