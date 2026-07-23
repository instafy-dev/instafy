pub(crate) const PROVIDER_ID_SELF_HOSTED: &str = "self_hosted";
pub(crate) const PROVIDER_ID_INSTAFY_CLOUD: &str = "instafy_cloud";

pub(crate) const PROVIDER_KIND_SELF_HOSTED: &str = "self_hosted";
pub(crate) const PROVIDER_KIND_EXTERNAL_HTTP: &str = "external_http";

pub(crate) fn normalize_identifier(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity(trimmed.len());
    let mut pending_separator = false;
    for ch in trimmed.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower == '-' || lower == '_' || lower.is_ascii_whitespace() {
            pending_separator = true;
            continue;
        }

        if pending_separator && !out.is_empty() {
            out.push('_');
        }
        pending_separator = false;
        out.push(lower);
    }

    while out.ends_with('_') {
        out.pop();
    }

    out
}

pub(crate) fn provider_id_key(raw: &str) -> String {
    normalize_identifier(raw)
}

pub(crate) fn provider_kind_key(raw: &str) -> String {
    let normalized = normalize_identifier(raw);
    match normalized.as_str() {
        "http" => PROVIDER_KIND_EXTERNAL_HTTP.to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn canonical_provider_kind(raw: &str) -> String {
    let normalized = provider_kind_key(raw);
    match normalized.as_str() {
        PROVIDER_KIND_SELF_HOSTED => "self-hosted".to_string(),
        PROVIDER_KIND_EXTERNAL_HTTP => PROVIDER_KIND_EXTERNAL_HTTP.to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn is_self_hosted_provider_id(provider_id: &str) -> bool {
    provider_id_key(provider_id) == PROVIDER_ID_SELF_HOSTED
}

pub(crate) fn is_instafy_cloud_provider_id(provider_id: &str) -> bool {
    let key = provider_id_key(provider_id);
    if key == PROVIDER_ID_INSTAFY_CLOUD {
        return true;
    }
    key.strip_prefix(PROVIDER_ID_INSTAFY_CLOUD)
        .and_then(|suffix| suffix.strip_prefix('_'))
        .is_some()
}

/// Return whether this is the one controller-trusted Instafy Cloud route.
///
/// Prefix matching is useful for metering and inventory, but it is not an
/// authority boundary: provider ids are configurable and an external endpoint
/// must not receive controller credentials or Shared Browser authority merely
/// by choosing an `instafy-cloud-*` name. Production's atomic topology
/// preflight independently requires this exact canonical route.
pub(crate) fn is_trusted_instafy_cloud_provider_id(provider_id: &str) -> bool {
    provider_id_key(provider_id) == PROVIDER_ID_INSTAFY_CLOUD
}

pub(crate) fn is_self_hosted_provider_kind(kind: &str) -> bool {
    provider_kind_key(kind) == PROVIDER_KIND_SELF_HOSTED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_identifier_handles_hyphens_and_whitespace() {
        assert_eq!(normalize_identifier(" self-hosted "), "self_hosted");
        assert_eq!(normalize_identifier("self_hosted"), "self_hosted");
        assert_eq!(normalize_identifier("instafy-cloud"), "instafy_cloud");
        assert_eq!(normalize_identifier("instafy cloud"), "instafy_cloud");
    }

    #[test]
    fn is_instafy_cloud_provider_id_accepts_family_ids() {
        assert!(is_instafy_cloud_provider_id("instafy-cloud"));
        assert!(is_instafy_cloud_provider_id("instafy-cloud-large"));
        assert!(is_instafy_cloud_provider_id("instafy_cloud_webdev"));
        assert!(!is_instafy_cloud_provider_id("instafy-clouded"));
        assert!(!is_instafy_cloud_provider_id("instafy"));
    }

    #[test]
    fn trusted_instafy_cloud_provider_id_is_exactly_canonical() {
        assert!(is_trusted_instafy_cloud_provider_id("instafy-cloud"));
        assert!(is_trusted_instafy_cloud_provider_id(" Instafy Cloud "));
        assert!(!is_trusted_instafy_cloud_provider_id(
            "instafy-cloud-custom"
        ));
        assert!(!is_trusted_instafy_cloud_provider_id(
            "instafy_cloud_dedicated"
        ));
    }

    #[test]
    fn provider_kind_key_handles_aliases() {
        assert_eq!(provider_kind_key("http"), PROVIDER_KIND_EXTERNAL_HTTP);
        assert_eq!(
            provider_kind_key("external-http"),
            PROVIDER_KIND_EXTERNAL_HTTP
        );
        assert_eq!(
            provider_kind_key("external_http"),
            PROVIDER_KIND_EXTERNAL_HTTP
        );
    }

    #[test]
    fn canonical_provider_kind_preserves_self_hosted_label() {
        assert_eq!(canonical_provider_kind("self-hosted"), "self-hosted");
        assert_eq!(canonical_provider_kind("self_hosted"), "self-hosted");
        assert_eq!(canonical_provider_kind("http"), PROVIDER_KIND_EXTERNAL_HTTP);
    }
}
