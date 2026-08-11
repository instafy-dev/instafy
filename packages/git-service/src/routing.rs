use crate::error::ServiceError;
use axum::http::Method;
pub use runtime_contracts::GIT_DELETE_SCOPE;
use uuid::Uuid;

pub const GIT_DELETE_RESULT_HEADER: &str = "x-instafy-git-delete-result";
pub const GIT_DELETE_RESULT_DELETED: &str = "deleted-v1";
pub const GIT_DELETE_RESULT_ABSENT: &str = "absent-v1";

pub fn parse_repo_segment(path: &str) -> Result<(String, String), ServiceError> {
    let trimmed = path.trim_start_matches('/');
    let Some(first) = trimmed.split('/').next() else {
        return Err(ServiceError::not_found("missing repo path"));
    };
    if first.is_empty() || !first.ends_with(".git") {
        return Err(ServiceError::not_found("expected /<repo>.git/..."));
    }
    if first.contains('\\') || first.contains("..") {
        return Err(ServiceError::bad_request("invalid repo path"));
    }
    let repo_dir = first.to_string();
    let repo_name = first.trim_end_matches(".git").to_string();
    if repo_name.is_empty() || !is_safe_repo_name(&repo_name) {
        return Err(ServiceError::bad_request("invalid repo name"));
    }
    Ok((repo_dir, repo_name))
}

/// Return whether this request is the one repository-destruction shape the
/// public edge and private shard support.
///
/// Destruction deliberately has no path normalization or compatibility
/// variants: it is only `DELETE /<canonical-uuid>.git` without a query. This
/// helper is shared by both hops so the edge cannot authorize one shape while
/// the shard interprets another.
pub fn is_exact_repo_root_delete(
    method: &Method,
    path: &str,
    query: Option<&str>,
) -> Result<bool, ServiceError> {
    if method != Method::DELETE {
        return Ok(false);
    }

    let (repo_dir, repo_name) = parse_repo_segment(path)?;
    let canonical_project_id = Uuid::parse_str(&repo_name)
        .ok()
        .filter(|project_id| project_id.to_string() == repo_name)
        .ok_or_else(|| {
            ServiceError::bad_request(
                "repository deletion requires a canonical lowercase UUID repo name",
            )
        })?;
    let expected_path = format!("/{canonical_project_id}.git");

    if path != expected_path || repo_dir != format!("{canonical_project_id}.git") || query.is_some()
    {
        return Err(ServiceError::bad_request(
            "repository deletion requires exact DELETE /<uuid>.git without a query",
        ));
    }

    Ok(true)
}

pub fn required_scope(
    method: &Method,
    path: &str,
    query: Option<&str>,
) -> Result<&'static str, ServiceError> {
    if is_exact_repo_root_delete(method, path, query)? {
        return Ok(GIT_DELETE_SCOPE);
    }

    let lower_path = path.to_ascii_lowercase();
    if lower_path.contains("git-receive-pack") {
        return Ok("git.write");
    }
    if let Some(query) = query {
        if query
            .to_ascii_lowercase()
            .contains("service=git-receive-pack")
        {
            return Ok("git.write");
        }
    }
    Ok("git.read")
}

pub fn pick_shard_index(repo_name: &str, shard_count: usize) -> usize {
    if shard_count <= 1 {
        return 0;
    }
    (fnv1a_64(repo_name.as_bytes()) % shard_count as u64) as usize
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x00000100000001B3);
    }
    hash
}

fn is_safe_repo_name(name: &str) -> bool {
    name.bytes().all(|b| match b {
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => true,
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT_ID: &str = "8ff62ca8-9150-4a4d-9940-6f2c922b2e4d";

    #[test]
    fn exact_repo_root_delete_requires_delete_scope() {
        let path = format!("/{PROJECT_ID}.git");
        assert!(is_exact_repo_root_delete(&Method::DELETE, &path, None).unwrap());
        assert_eq!(
            required_scope(&Method::DELETE, &path, None).unwrap(),
            GIT_DELETE_SCOPE
        );
        assert_eq!(
            required_scope(&Method::GET, &path, None).unwrap(),
            "git.read"
        );
    }

    #[test]
    fn delete_route_rejects_every_nearby_shape() {
        for path in [
            format!("/{PROJECT_ID}.git/"),
            format!("//{PROJECT_ID}.git"),
            format!("/{PROJECT_ID}.git/info/refs"),
            format!("/{PROJECT_ID}.git/git-receive-pack"),
            "/not-a-uuid.git".to_string(),
            format!("/{}.git", PROJECT_ID.to_ascii_uppercase()),
        ] {
            assert!(
                required_scope(&Method::DELETE, &path, None).is_err(),
                "unsafe DELETE shape was accepted: {path}"
            );
        }

        let path = format!("/{PROJECT_ID}.git");
        assert!(required_scope(&Method::DELETE, &path, Some("")).is_err());
        assert!(required_scope(&Method::DELETE, &path, Some("force=1")).is_err());
    }

    #[test]
    fn smart_http_scope_classification_is_unchanged() {
        let path = format!("/{PROJECT_ID}.git/info/refs");
        assert_eq!(
            required_scope(&Method::GET, &path, Some("service=git-upload-pack")).unwrap(),
            "git.read"
        );
        assert_eq!(
            required_scope(&Method::GET, &path, Some("service=git-receive-pack")).unwrap(),
            "git.write"
        );
        assert_eq!(
            required_scope(
                &Method::POST,
                &format!("/{PROJECT_ID}.git/git-receive-pack"),
                None,
            )
            .unwrap(),
            "git.write"
        );
    }
}
