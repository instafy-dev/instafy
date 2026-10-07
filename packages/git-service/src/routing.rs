use crate::error::ServiceError;
use axum::http::Method;
use runtime_contracts::AccessTokenClaims;
pub use runtime_contracts::GIT_DELETE_SCOPE;
use uuid::Uuid;

/// Header names under this prefix carry assertions between Git Edge and a Git
/// Shard, such as [`GIT_DELETE_RESULT_HEADER`]. Git Edge drops every request
/// header in this namespace, so a shard never receives one a client wrote.
pub const GIT_SERVICE_HEADER_PREFIX: &str = "x-instafy-git-";

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

/// Check validated token claims against one request to `repo_name`: the
/// `git` protocol, that project, and the scope [`required_scope`] names for
/// the request. Signature, audience and expiry are checked by
/// [`crate::auth::TokenValidator`] before this. A shard trusts Git Edge for
/// every request but a repository deletion, so this is the only check of
/// an ordinary push or read.
pub fn authorize_request_claims(
    claims: &AccessTokenClaims,
    method: &Method,
    path: &str,
    query: Option<&str>,
    repo_name: &str,
) -> Result<(), ServiceError> {
    if claims.protocol.as_deref() != Some("git") {
        return Err(ServiceError::forbidden("token protocol mismatch"));
    }
    if claims.project_id != repo_name {
        return Err(ServiceError::forbidden("project mismatch"));
    }
    let required_scope = required_scope(method, path, query)?;
    if claims.scopes.iter().any(|value| value == required_scope) {
        return Ok(());
    }
    Err(ServiceError::forbidden(format!(
        "missing required scope {required_scope}"
    )))
}

/// Whether a client request header may pass through Git Edge to a shard.
pub fn is_forwardable_request_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name != "host" && !name.starts_with(GIT_SERVICE_HEADER_PREFIX)
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
    fn edge_drops_host_and_reserved_git_service_request_headers() {
        for dropped in [
            "host",
            "Host",
            GIT_DELETE_RESULT_HEADER,
            "X-Instafy-Git-Delete-Result",
            "x-instafy-git-push-claim",
            "x-instafy-git-",
        ] {
            assert!(
                !is_forwardable_request_header(dropped),
                "{dropped} reached the shard"
            );
        }
        for forwarded in [
            "authorization",
            "content-type",
            "content-length",
            "content-encoding",
            "git-protocol",
            "x-instafy-hook-token",
            "x-instafy-gitx",
        ] {
            assert!(
                is_forwardable_request_header(forwarded),
                "{forwarded} was dropped"
            );
        }
    }

    const OTHER_PROJECT_ID: &str = "0b4f2c1e-6a3d-4f5e-8c7b-9a8d7e6f5a4b";

    /// Validated claims of a Git grant for [`PROJECT_ID`] with `scopes`.
    fn claims(scopes: &[&str]) -> AccessTokenClaims {
        AccessTokenClaims {
            aud: "git".to_string(),
            sub: Uuid::new_v4().to_string(),
            project_id: PROJECT_ID.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: Some("git".to_string()),
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: 1_700_000_000,
            exp: 1_700_000_600,
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }
    }

    type RequestShape = (Method, String, Option<String>);

    fn shape(method: Method, suffix: &str, query: Option<&str>) -> RequestShape {
        (
            method,
            format!("/{PROJECT_ID}.git{suffix}"),
            query.map(str::to_string),
        )
    }

    /// The two requests of a push.
    fn push_requests() -> Vec<RequestShape> {
        vec![
            shape(Method::GET, "/info/refs", Some("service=git-receive-pack")),
            shape(Method::POST, "/git-receive-pack", None),
        ]
    }

    /// Reads, including ones `git http-backend` serves although the path or
    /// query mentions git-receive-pack, near misses of the push requests,
    /// and the repository deletion.
    fn other_requests() -> Vec<RequestShape> {
        let object = "/objects/ab/cdef0123456789abcdef0123456789abcdef01";
        let pack = "/objects/pack/pack-0123456789abcdef0123456789abcdef01234567.pack";
        let receive = Some("service=git-receive-pack");
        let mut requests = vec![
            // Plain reads and deletion.
            shape(Method::GET, "/info/refs", Some("service=git-upload-pack")),
            shape(Method::GET, "/info/refs", None),
            shape(Method::POST, "/git-upload-pack", None),
            shape(Method::GET, "/HEAD", None),
            shape(Method::GET, object, None),
            shape(Method::DELETE, "", None),
            // Reads that mention git-receive-pack. git http-backend routes by
            // path and uses the last service= value.
            shape(
                Method::GET,
                "/info/refs",
                Some("service=git-receive-pack&service=git-upload-pack"),
            ),
            shape(
                Method::GET,
                "/info/refs",
                Some("service=git-upload-pack&service=git-receive-pack"),
            ),
            shape(
                Method::GET,
                "/info/refs",
                Some("x=service=git-receive-pack"),
            ),
            shape(
                Method::GET,
                "/info/refs",
                Some("service=git-receive-pack&x=1"),
            ),
            shape(Method::POST, "/git-upload-pack", receive),
            shape(Method::GET, "/HEAD", receive),
            shape(Method::GET, object, receive),
            shape(Method::GET, pack, receive),
            shape(Method::GET, "/objects/info/packs", receive),
            shape(Method::GET, "/objects/info/alternates", receive),
            shape(Method::GET, "/objects/info/http-alternates", receive),
            shape(Method::GET, "/info/refs/git-receive-pack", None),
            shape(Method::GET, "/objects/git-receive-pack", None),
            // Near misses of the two push requests.
            shape(Method::POST, "/git-receive-pack", receive),
            shape(Method::POST, "/git-receive-pack", Some("")),
            shape(Method::GET, "/git-receive-pack", None),
            shape(Method::PUT, "/git-receive-pack", None),
            shape(Method::POST, "/info/refs", receive),
            shape(Method::HEAD, "/info/refs", receive),
            shape(Method::GET, "/info/refs", Some("SERVICE=GIT-RECEIVE-PACK")),
            shape(Method::GET, "/info/refs", Some("service=git-receive-pack&")),
            shape(Method::GET, "/INFO/REFS", receive),
            shape(Method::POST, "/GIT-RECEIVE-PACK", None),
            shape(Method::POST, "//git-receive-pack", None),
            shape(Method::POST, "/git-receive-pack/", None),
            shape(Method::POST, "/./git-receive-pack", None),
            shape(Method::POST, "/x/../git-receive-pack", None),
        ];
        for path in [
            format!("//{PROJECT_ID}.git/git-receive-pack"),
            format!("/{PROJECT_ID}/git-receive-pack"),
            format!("/x/{PROJECT_ID}.git/git-receive-pack"),
            format!("{PROJECT_ID}.git/git-receive-pack"),
        ] {
            requests.push((Method::POST, path, None));
        }
        requests
    }

    fn every_request() -> Vec<RequestShape> {
        let mut requests = push_requests();
        requests.extend(other_requests());
        requests
    }

    /// Git Edge's only check of an ordinary push or read: the shard trusts
    /// it. Each grant passes exactly when it lists the scope
    /// [`required_scope`] names for the request, for its own project and the
    /// `git` protocol only.
    #[test]
    fn ordinary_grants_are_authorized_exactly_as_before() {
        let write = claims(&["git.read", "git.write"]);
        let read = claims(&["git.read"]);
        let write_only = claims(&["git.write"]);

        for grant in [&write, &read, &write_only] {
            for (method, path, query) in &every_request() {
                let needed = required_scope(method, path, query.as_deref()).unwrap();
                assert_eq!(
                    authorize_request_claims(grant, method, path, query.as_deref(), PROJECT_ID)
                        .is_ok(),
                    grant.scopes.iter().any(|scope| scope == needed),
                    "{:?} {method} {path}?{query:?}",
                    grant.scopes
                );
            }
        }
        for (method, path, query) in push_requests() {
            assert_eq!(
                required_scope(&method, &path, query.as_deref()).unwrap(),
                "git.write"
            );
            authorize_request_claims(&write, &method, &path, query.as_deref(), PROJECT_ID).unwrap();
            assert!(
                authorize_request_claims(&read, &method, &path, query.as_deref(), PROJECT_ID)
                    .is_err()
            );
        }

        // Another project's grant, and one for another protocol or none,
        // pass nowhere.
        let upload = format!("/{PROJECT_ID}.git/git-upload-pack");
        authorize_request_claims(&read, &Method::POST, &upload, None, PROJECT_ID).unwrap();
        for (method, path, query) in &every_request() {
            assert!(authorize_request_claims(
                &write,
                method,
                path,
                query.as_deref(),
                OTHER_PROJECT_ID
            )
            .is_err());
        }
        let mut http = write.clone();
        http.protocol = Some("http".to_string());
        let mut unnamed = write.clone();
        unnamed.protocol = None;
        for grant in [&http, &unnamed] {
            for (method, path, query) in &every_request() {
                assert!(authorize_request_claims(
                    grant,
                    method,
                    path,
                    query.as_deref(),
                    PROJECT_ID
                )
                .is_err());
            }
        }
    }

    /// A scope the edge does not know (`git.salvage`, a push credential's
    /// scope once) grants nothing, alone or beside another; and the delete
    /// scope grants neither reads nor pushes.
    #[test]
    fn a_scope_grants_only_what_required_scope_names() {
        let salvage = claims(&["git.salvage"]);
        let salvage_and_read = claims(&["git.salvage", "git.read"]);
        let delete = claims(&[GIT_DELETE_SCOPE]);
        for (method, path, query) in &every_request() {
            let needed = required_scope(method, path, query.as_deref()).unwrap();
            let allowed = |grant: &AccessTokenClaims| {
                authorize_request_claims(grant, method, path, query.as_deref(), PROJECT_ID).is_ok()
            };
            let shape = format!("{method} {path}?{query:?}");
            assert!(!allowed(&salvage), "{shape}");
            assert_eq!(allowed(&salvage_and_read), needed == "git.read", "{shape}");
            assert_eq!(allowed(&delete), needed == GIT_DELETE_SCOPE, "{shape}");
        }
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
