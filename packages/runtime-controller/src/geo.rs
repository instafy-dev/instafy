use axum::http::HeaderMap;

const CLOUDFLARE_COUNTRY_HEADER: &str = "CF-IPCountry";

pub(crate) fn extract_country_code_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(CLOUDFLARE_COUNTRY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let normalized = raw.to_ascii_uppercase();
    if normalized == "XX" || normalized == "T1" {
        return None;
    }
    if normalized.len() != 2 || !normalized.chars().all(|ch| ch.is_ascii_uppercase()) {
        return None;
    }
    Some(normalized)
}

#[cfg(test)]
mod tests {
    use super::extract_country_code_from_headers;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn extracts_valid_country_code() {
        let mut headers = HeaderMap::new();
        headers.insert("CF-IPCountry", HeaderValue::from_static("at"));
        assert_eq!(
            extract_country_code_from_headers(&headers).as_deref(),
            Some("AT")
        );
    }

    #[test]
    fn ignores_unknown_or_special_values() {
        for value in ["", "XX", "T1", "123", "a"] {
            let mut headers = HeaderMap::new();
            if !value.is_empty() {
                headers.insert(
                    "CF-IPCountry",
                    HeaderValue::from_str(value).expect("header"),
                );
            }
            assert_eq!(extract_country_code_from_headers(&headers), None);
        }
    }
}
