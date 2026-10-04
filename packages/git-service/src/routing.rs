use crate::error::ServiceError;
use axum::http::Method;
use runtime_contracts::{
    AccessTokenClaims, GIT_SALVAGE_TOKEN_SUBJECT, GIT_SALVAGE_TOKEN_TTL_SECONDS,
};
pub use runtime_contracts::{GIT_DELETE_SCOPE, GIT_SALVAGE_SCOPE};
use uuid::Uuid;

/// Scope every Smart HTTP push (`git-receive-pack`) requires.
pub const GIT_WRITE_SCOPE: &str = "git.write";

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

/// Scope an ordinary token needs for a request. Any request whose path or
/// query mentions `git-receive-pack` needs `git.write`; everything else but
/// repository deletion needs `git.read`. The salvage credential does not use
/// this classification: it is accepted only for
/// [`is_exact_receive_pack_request`].
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
        return Ok(GIT_WRITE_SCOPE);
    }
    if let Some(query) = query {
        if query
            .to_ascii_lowercase()
            .contains("service=git-receive-pack")
        {
            return Ok(GIT_WRITE_SCOPE);
        }
    }
    Ok("git.read")
}

/// Whether a request is exactly one of the two requests of a Smart HTTP
/// push, and nothing else: the ref advertisement
/// `GET /<repo>.git/info/refs?service=git-receive-pack` and the push
/// `POST /<repo>.git/git-receive-pack` without a query. Shared by Git Edge and
/// Git Shard, so both accept the salvage credential for the same requests.
///
/// `git http-backend` serves reads for many other shapes that still mention
/// `git-receive-pack` (an upload-pack request with that query appended, a
/// second `service=` parameter, dumb-HTTP `HEAD` and object paths), so no
/// looser match may stand in for this one.
pub fn is_exact_receive_pack_request(method: &Method, path: &str, query: Option<&str>) -> bool {
    let Some((repo_dir, endpoint)) = path.strip_prefix('/').and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    if !parse_repo_segment(path).is_ok_and(|(parsed_dir, _)| parsed_dir == repo_dir) {
        return false;
    }
    match (endpoint, query) {
        ("info/refs", Some("service=git-receive-pack")) => *method == Method::GET,
        ("git-receive-pack", None) => *method == Method::POST,
        _ => false,
    }
}

/// Check validated token claims against one request to `repo_name`.
///
/// An ordinary token needs the scope [`required_scope`] names. A token that
/// names `git.salvage` is only ever the controller's salvage credential: it is
/// accepted for the two requests of a push ([`is_exact_receive_pack_request`])
/// and only in its exact shape ([`validate_salvage_push_claims`]), and refused
/// for every other request whatever else it holds. The shard then marks that
/// push as a salvage push, which may only create salvage refs.
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
    if claims.scopes.iter().any(|value| value == GIT_SALVAGE_SCOPE) {
        if !is_exact_receive_pack_request(method, path, query) {
            return Err(ServiceError::forbidden(
                "git.salvage is accepted only for the requests of a push",
            ));
        }
        return validate_salvage_push_claims(claims, repo_name);
    }
    let required_scope = required_scope(method, path, query)?;
    if claims.scopes.iter().any(|value| value == required_scope) {
        return Ok(());
    }
    Err(ServiceError::forbidden(format!(
        "missing required scope {required_scope}"
    )))
}

/// Require the exact shape of the controller's salvage credential for
/// `repo_name`: protocol `git`, that project, the salvage subject, `git.salvage`
/// as the only scope, the fixed lifetime, and no runtime, origin, lease, run
/// or browser binding. Signature, audience and expiry are checked by
/// [`crate::auth::TokenValidator`] before this.
pub fn validate_salvage_push_claims(
    claims: &AccessTokenClaims,
    repo_name: &str,
) -> Result<(), ServiceError> {
    if claims.protocol.as_deref() != Some("git") {
        return Err(ServiceError::forbidden("token protocol mismatch"));
    }
    if claims.project_id != repo_name {
        return Err(ServiceError::forbidden("project mismatch"));
    }
    if claims.sub != GIT_SALVAGE_TOKEN_SUBJECT {
        return Err(ServiceError::forbidden("salvage token subject mismatch"));
    }
    if claims.scopes.as_slice() != [GIT_SALVAGE_SCOPE] {
        return Err(ServiceError::forbidden(
            "salvage pushes require the exact git.salvage scope",
        ));
    }
    if claims.origin_id.is_some()
        || claims.runtime_id.is_some()
        || claims.lease_id.is_some()
        || claims.runtime_generation.is_some()
        || claims.run_id.is_some()
        || claims.prefer_runtime.is_some()
        || claims.actor_label.is_some()
        || claims.browser_session_id.is_some()
    {
        return Err(ServiceError::forbidden(
            "salvage token must be controller-scoped",
        ));
    }
    if claims.exp.checked_sub(claims.iat) != Some(GIT_SALVAGE_TOKEN_TTL_SECONDS) {
        return Err(ServiceError::forbidden("salvage token lifetime mismatch"));
    }
    Ok(())
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
            "x-instafy-git-salvage-claim",
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

    fn salvage_claims() -> AccessTokenClaims {
        AccessTokenClaims {
            aud: "git".to_string(),
            sub: GIT_SALVAGE_TOKEN_SUBJECT.to_string(),
            project_id: PROJECT_ID.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: Some("git".to_string()),
            scopes: vec![GIT_SALVAGE_SCOPE.to_string()],
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: 1_700_000_000,
            exp: 1_700_000_000 + GIT_SALVAGE_TOKEN_TTL_SECONDS,
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
    /// query mentions git-receive-pack, and near misses of the push requests.
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

    #[test]
    fn exact_receive_pack_matcher_accepts_only_the_two_push_requests() {
        for (method, path, query) in push_requests() {
            assert!(
                is_exact_receive_pack_request(&method, &path, query.as_deref()),
                "{method} {path}?{query:?}"
            );
        }
        for (method, path, query) in other_requests() {
            assert!(
                !is_exact_receive_pack_request(&method, &path, query.as_deref()),
                "{method} {path}?{query:?}"
            );
        }
    }

    #[test]
    fn salvage_credential_authorizes_only_the_two_push_requests() {
        let claims = salvage_claims();
        validate_salvage_push_claims(&claims, PROJECT_ID).expect("exact salvage claims");

        for (method, path, query) in push_requests() {
            authorize_request_claims(&claims, &method, &path, query.as_deref(), PROJECT_ID)
                .unwrap_or_else(|error| panic!("{method} {path}: {error}"));
            assert!(authorize_request_claims(
                &claims,
                &method,
                &path,
                query.as_deref(),
                OTHER_PROJECT_ID
            )
            .is_err());
        }
        // Never a read, a deletion, or a request that only mentions
        // git-receive-pack.
        for (method, path, query) in other_requests() {
            assert!(
                authorize_request_claims(&claims, &method, &path, query.as_deref(), PROJECT_ID)
                    .is_err(),
                "salvage credential authorized {method} {path}?{query:?}"
            );
        }
    }

    #[test]
    fn a_token_naming_salvage_never_gets_another_scope() {
        let mut requests = push_requests();
        requests.extend(other_requests());
        for scopes in [
            vec!["git.read", GIT_SALVAGE_SCOPE],
            vec!["git.read", GIT_WRITE_SCOPE, GIT_SALVAGE_SCOPE],
            vec![GIT_SALVAGE_SCOPE, GIT_WRITE_SCOPE],
            vec![GIT_DELETE_SCOPE, GIT_SALVAGE_SCOPE],
        ] {
            let mut claims = salvage_claims();
            claims.scopes = scopes.iter().map(|scope| scope.to_string()).collect();
            for (method, path, query) in &requests {
                assert!(
                    authorize_request_claims(&claims, method, path, query.as_deref(), PROJECT_ID)
                        .is_err(),
                    "{scopes:?} authorized {method} {path}?{query:?}"
                );
            }
        }
    }

    #[test]
    fn salvage_credential_is_refused_in_any_other_shape() {
        let claims = salvage_claims();
        let binding = Some(Uuid::new_v4().to_string());
        let push = format!("/{PROJECT_ID}.git/git-receive-pack");
        let changes: [(&str, fn(&mut AccessTokenClaims, Option<String>)); 18] = [
            ("project", |c, _| {
                c.project_id = OTHER_PROJECT_ID.to_string()
            }),
            ("protocol", |c, _| c.protocol = Some("http".to_string())),
            ("missing protocol", |c, _| c.protocol = None),
            ("delete subject", |c, _| {
                c.sub = runtime_contracts::GIT_DELETE_TOKEN_SUBJECT.to_string()
            }),
            ("user subject", |c, _| c.sub = Uuid::new_v4().to_string()),
            ("extra write scope", |c, _| {
                c.scopes.push("git.write".into())
            }),
            ("extra read scope", |c, _| {
                c.scopes.insert(0, "git.read".into())
            }),
            ("repeated scope", |c, _| {
                c.scopes.push(GIT_SALVAGE_SCOPE.into())
            }),
            ("longer lifetime", |c, _| c.exp += 1),
            ("shorter lifetime", |c, _| c.exp -= 1),
            ("origin", |c, value| c.origin_id = value),
            ("runtime", |c, value| c.runtime_id = value),
            ("lease", |c, value| c.lease_id = value),
            ("runtime generation", |c, value| {
                c.runtime_generation = value
            }),
            ("run", |c, value| c.run_id = value),
            ("preferred runtime", |c, value| c.prefer_runtime = value),
            ("actor label", |c, value| c.actor_label = value),
            ("browser session", |c, value| c.browser_session_id = value),
        ];
        for (label, change) in changes {
            let mut candidate = claims.clone();
            change(&mut candidate, binding.clone());
            assert!(
                validate_salvage_push_claims(&candidate, PROJECT_ID).is_err(),
                "{label}: salvage claims were accepted"
            );
            assert!(
                authorize_request_claims(&candidate, &Method::POST, &push, None, PROJECT_ID)
                    .is_err(),
                "{label}: push was authorized"
            );
        }
    }

    #[test]
    fn ordinary_tokens_are_authorized_exactly_as_before() {
        let mut write = salvage_claims();
        write.sub = Uuid::new_v4().to_string();
        write.scopes = vec!["git.read".to_string(), GIT_WRITE_SCOPE.to_string()];
        write.exp = write.iat + 600;
        let mut read = write.clone();
        read.scopes = vec!["git.read".to_string()];
        let mut write_only = write.clone();
        write_only.scopes = vec![GIT_WRITE_SCOPE.to_string()];

        // The scope an ordinary token needs still comes from required_scope,
        // for every shape, including the loose receive-pack matches.
        let mut requests = push_requests();
        requests.extend(other_requests());
        for claims in [&write, &read, &write_only] {
            for (method, path, query) in &requests {
                let needed = required_scope(method, path, query.as_deref()).unwrap();
                assert_eq!(
                    authorize_request_claims(claims, method, path, query.as_deref(), PROJECT_ID)
                        .is_ok(),
                    claims.scopes.iter().any(|scope| scope == needed),
                    "{:?} {method} {path}?{query:?}",
                    claims.scopes
                );
            }
        }
        for (method, path, query) in push_requests() {
            assert_eq!(
                required_scope(&method, &path, query.as_deref()).unwrap(),
                GIT_WRITE_SCOPE
            );
            authorize_request_claims(&write, &method, &path, query.as_deref(), PROJECT_ID).unwrap();
            assert!(
                authorize_request_claims(&read, &method, &path, query.as_deref(), PROJECT_ID)
                    .is_err()
            );
        }
        let upload = format!("/{PROJECT_ID}.git/git-upload-pack");
        authorize_request_claims(&read, &Method::POST, &upload, None, PROJECT_ID).unwrap();
        assert!(
            authorize_request_claims(&write, &Method::POST, &upload, None, OTHER_PROJECT_ID)
                .is_err()
        );
        assert!(validate_salvage_push_claims(&write, PROJECT_ID).is_err());
        let mut http = write.clone();
        http.protocol = Some("http".to_string());
        assert!(authorize_request_claims(&http, &Method::POST, &upload, None, PROJECT_ID).is_err());
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
