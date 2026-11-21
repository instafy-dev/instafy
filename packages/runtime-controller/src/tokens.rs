use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{
    decode, encode, Algorithm, DecodingKey, EncodingKey, Header as JwtHeader, Validation,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::author_identity::AuthorClaims;
use crate::{config::AppConfig, internal_error, unauthorized, ApiError};
use runtime_contracts::AccessTokenClaims;

/// The signed payload: the shared claims plus the optional author claims of
/// a workspace-write token. The author claims are serialized next to the
/// shared ones instead of extending [`AccessTokenClaims`], so no other crate
/// that builds or checks those claims changes; origins that do not read
/// `author_name` / `author_email` ignore them.
#[derive(Serialize)]
struct SignedAccessTokenClaims<'a> {
    #[serde(flatten)]
    claims: &'a AccessTokenClaims,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_email: Option<&'a str>,
}

#[derive(Debug)]
pub struct ScopedTokenRequest {
    pub audience: String,
    pub subject: String,
    pub project_id: String,
    pub origin_id: Option<String>,
    pub runtime_id: Option<String>,
    pub protocol: Option<String>,
    pub scopes: Vec<String>,
    pub lease_id: Option<String>,
    pub run_id: Option<String>,
    pub prefer_runtime: Option<String>,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug)]
pub struct MintedAccessToken {
    pub token: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub scopes: Vec<String>,
    pub ttl: i64,
    pub jti: Uuid,
}

pub(crate) fn derive_origin_key_id_from_pem(pem: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pem.trim().as_bytes());
    let digest = hasher.finalize();
    let encoded = URL_SAFE_NO_PAD.encode(digest);
    let suffix = encoded.get(0..16).unwrap_or(&encoded);
    format!("origin-{suffix}")
}

/// The PKCS#8 v1 (RFC 8410) header of an Ed25519 private key. The 32-byte
/// seed follows it.
const ED25519_PKCS8_V1_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// The signing key for the configured PKCS#8 PEM.
///
/// The PEM is read by jsonwebtoken's own reader, as in jsonwebtoken 9, so
/// the same text still loads: it drops every whitespace character from the
/// body, including the spaces left where a key's line breaks were pasted.
///
/// jsonwebtoken signs with AWS-LC, which parses an Ed25519 key as PKCS#8 v1
/// or RFC 5958 v2 but not as the v2 layout ring 0.16 and earlier wrote (the
/// public key under a constructed `[1]`). jsonwebtoken 9 signed through
/// ring, which took all three. So the key is checked with that same ring
/// parser, which also refuses a v2 key whose public key is not its own, and
/// its seed is handed on as a v1 document. The configured PEM itself is not
/// changed, so the key id derived from it stays the same.
fn ed25519_encoding_key(private_key_pem: &str) -> anyhow::Result<EncodingKey> {
    let pem_key = EncodingKey::from_ed_pem(private_key_pem.as_bytes())
        .map_err(|error| anyhow::anyhow!("not an Ed25519 PKCS#8 PEM: {error}"))?;
    let der = pem_key.inner();
    ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(der)
        .map_err(|error| anyhow::anyhow!("not a PKCS#8 Ed25519 private key: {error}"))?;
    let seed = ed25519_pkcs8_seed(der)
        .ok_or_else(|| anyhow::anyhow!("PKCS#8 Ed25519 private key has no 32-byte seed"))?;
    let mut v1 = ED25519_PKCS8_V1_PREFIX.to_vec();
    v1.extend_from_slice(seed);
    Ok(EncodingKey::from_ed_der(&v1))
}

/// The seed of a PKCS#8 Ed25519 private key that ring has accepted:
/// `SEQUENCE { version, algorithm, OCTET STRING { OCTET STRING seed }, .. }`.
fn ed25519_pkcs8_seed(der: &[u8]) -> Option<&[u8]> {
    let (0x30, info, _) = der_element(der)? else {
        return None;
    };
    let (0x02, _version, info) = der_element(info)? else {
        return None;
    };
    let (0x30, _algorithm, info) = der_element(info)? else {
        return None;
    };
    let (0x04, private_key, _) = der_element(info)? else {
        return None;
    };
    let (0x04, seed, _) = der_element(private_key)? else {
        return None;
    };
    (seed.len() == 32).then_some(seed)
}

/// Splits the first DER element off `input` as (tag, contents, rest).
fn der_element(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = match first {
        0x00..=0x7f => (usize::from(first), rest),
        0x81 => {
            let (&length, rest) = rest.split_first()?;
            (usize::from(length), rest)
        }
        0x82 => {
            let (length, rest) = rest.split_at_checked(2)?;
            ((usize::from(length[0]) << 8) | usize::from(length[1]), rest)
        }
        _ => return None,
    };
    let (contents, rest) = rest.split_at_checked(length)?;
    Some((tag, contents, rest))
}

pub fn mint_scoped_token(
    config: &AppConfig,
    request: ScopedTokenRequest,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(config, request, None, None, None, None, None)
}

/// Mint a workspace-write token that names the user the origin should
/// author commits as (see [`crate::author_identity`]). `None` mints an
/// ordinary token, so the origin keeps its own identity.
pub fn mint_scoped_token_with_author(
    config: &AppConfig,
    request: ScopedTokenRequest,
    author: Option<AuthorClaims>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(config, request, None, None, None, None, author)
}

pub fn mint_scoped_token_with_runtime_generation(
    config: &AppConfig,
    request: ScopedTokenRequest,
    runtime_generation: Option<Uuid>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(config, request, runtime_generation, None, None, None, None)
}

/// Mint a runtime-scoped token with controller-attested collaborative browser
/// identity. Ordinary workspace/runtime tokens intentionally omit these
/// presentation/session fields. `author` is set only on workspace-write
/// tokens whose subject is a person.
pub fn mint_scoped_token_with_browser_actor(
    config: &AppConfig,
    request: ScopedTokenRequest,
    runtime_generation: Option<Uuid>,
    actor_label: Option<String>,
    browser_session_id: Option<String>,
    author: Option<AuthorClaims>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(
        config,
        request,
        runtime_generation,
        None,
        actor_label,
        browser_session_id,
        author,
    )
}

/// Mint a scoped token whose signed expiry cannot pass an external
/// authorization boundary such as a live workspace lease.
///
/// Ordinary scoped tokens retain the historical 60-second minimum. This
/// narrowly scoped path may shorten the resulting JWT below that floor so a
/// child capability never outlives the authority from which it was derived.
pub fn mint_scoped_token_expires_no_later_than(
    config: &AppConfig,
    request: ScopedTokenRequest,
    latest_expires_at: DateTime<Utc>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(
        config,
        request,
        None,
        Some(latest_expires_at),
        None,
        None,
        None,
    )
}

fn mint_scoped_token_inner(
    config: &AppConfig,
    request: ScopedTokenRequest,
    runtime_generation: Option<Uuid>,
    latest_expires_at: Option<DateTime<Utc>>,
    actor_label: Option<String>,
    browser_session_id: Option<String>,
    author: Option<AuthorClaims>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    let private_key_pem = config
        .origin_token_private_key
        .as_ref()
        .ok_or_else(|| internal_error("origin token signing key not configured"))?;

    let encoding_key = ed25519_encoding_key(private_key_pem).map_err(|error| {
        internal_error(format!(
            "failed to construct Ed25519 encoding key from PEM: {error}"
        ))
    })?;

    let issued_at = Utc::now();
    let ttl_source = request
        .ttl_seconds
        .unwrap_or(config.origin_token_ttl_seconds);
    let mut ttl = ttl_source.max(60);
    let mut expires_at = issued_at + ChronoDuration::seconds(ttl);
    if let Some(latest_expires_at) = latest_expires_at {
        let capped_exp_timestamp = expires_at.timestamp().min(latest_expires_at.timestamp());
        if capped_exp_timestamp <= issued_at.timestamp() {
            return Err(unauthorized("scoped token authorization window expired"));
        }
        expires_at = DateTime::<Utc>::from_timestamp(capped_exp_timestamp, 0)
            .ok_or_else(|| internal_error("failed to cap scoped token expiry"))?;
        ttl = capped_exp_timestamp - issued_at.timestamp();
    }
    let jti = Uuid::new_v4();

    let mut header = JwtHeader::new(Algorithm::EdDSA);
    header.kid = Some(
        config
            .origin_token_key_id
            .clone()
            .unwrap_or_else(|| derive_origin_key_id_from_pem(private_key_pem)),
    );

    let scopes = request.scopes.clone();

    let claims = AccessTokenClaims {
        aud: request.audience,
        sub: request.subject,
        project_id: request.project_id,
        origin_id: request.origin_id,
        runtime_id: request.runtime_id,
        protocol: request.protocol,
        scopes: scopes.clone(),
        lease_id: request.lease_id,
        runtime_generation: runtime_generation.map(|generation| generation.to_string()),
        run_id: request.run_id,
        iat: issued_at.timestamp(),
        exp: expires_at.timestamp(),
        jti: jti.to_string(),
        prefer_runtime: request.prefer_runtime,
        actor_label,
        browser_session_id,
    };

    let signed = SignedAccessTokenClaims {
        claims: &claims,
        author_name: author.as_ref().map(|author| author.name.as_str()),
        author_email: author.as_ref().map(|author| author.email.as_str()),
    };
    let token = encode(&header, &signed, &encoding_key)
        .map_err(|error| internal_error(format!("failed to sign access token: {error}")))?;

    Ok(MintedAccessToken {
        token,
        issued_at,
        expires_at,
        scopes,
        ttl,
        jti,
    })
}

pub fn decode_scoped_token(
    config: &AppConfig,
    token: &str,
    token_label: &str,
) -> Result<AccessTokenClaims, (StatusCode, Json<ApiError>)> {
    let decoding_source = config
        .origin_token_public_key
        .as_ref()
        .or(config.origin_token_private_key.as_ref())
        .ok_or_else(|| unauthorized(format!("{token_label} public/private key not configured")))?;

    let decoding_key = DecodingKey::from_ed_pem(decoding_source.as_bytes()).map_err(|error| {
        internal_error(format!(
            "failed to construct Ed25519 decoding key from PEM: {error}"
        ))
    })?;

    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.validate_exp = true;
    validation.validate_aud = false;

    let token_data = decode::<AccessTokenClaims>(token, &decoding_key, &validation).map_err(
        |error| match error.kind() {
            JwtErrorKind::ExpiredSignature => unauthorized(format!("{token_label} expired")),
            _ => unauthorized(format!("invalid {token_label}")),
        },
    )?;

    Ok(token_data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn request(ttl_seconds: i64) -> ScopedTokenRequest {
        ScopedTokenRequest {
            audience: "git".to_string(),
            subject: Uuid::new_v4().to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: Some("git".to_string()),
            scopes: vec!["git.read".to_string(), "git.write".to_string()],
            lease_id: Some(Uuid::new_v4().to_string()),
            run_id: Some(Uuid::new_v4().to_string()),
            prefer_runtime: None,
            ttl_seconds: Some(ttl_seconds),
        }
    }

    #[test]
    fn expiry_capped_child_token_can_be_shorter_than_global_minimum() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-expiry-cap",
        );
        let lease_expires_at = Utc::now() + ChronoDuration::seconds(27);
        let minted =
            mint_scoped_token_expires_no_later_than(&config, request(600), lease_expires_at)
                .expect("mint lease-capped child token");
        let claims = decode_scoped_token(&config, &minted.token, "lease-capped token")
            .expect("decode lease-capped child token");

        assert!(claims.exp <= lease_expires_at.timestamp());
        assert!(claims.exp - claims.iat > 0);
        assert!(claims.exp - claims.iat < 60);
        assert_eq!(minted.ttl, claims.exp - claims.iat);
    }

    #[test]
    fn expiry_capped_child_token_rejects_expired_authority() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-expired-cap",
        );
        assert!(mint_scoped_token_expires_no_later_than(
            &config,
            request(600),
            Utc::now() - ChronoDuration::seconds(1),
        )
        .is_err());
    }

    #[test]
    fn browser_actor_identity_is_signed_into_the_scoped_token() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-browser-actor",
        );
        let runtime_generation = Uuid::new_v4();
        let minted = mint_scoped_token_with_browser_actor(
            &config,
            request(600),
            Some(runtime_generation),
            Some("Ada Lovelace".to_string()),
            Some("browser-tab-123".to_string()),
            None,
        )
        .expect("mint browser actor token");
        let claims = decode_scoped_token(&config, &minted.token, "browser actor token")
            .expect("decode browser actor token");

        assert_eq!(claims.actor_label.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            claims.browser_session_id.as_deref(),
            Some("browser-tab-123")
        );
        assert_eq!(
            claims.runtime_generation.as_deref(),
            Some(runtime_generation.to_string().as_str())
        );
    }

    fn pem_block(label: &str, der: &[u8]) -> String {
        let body = STANDARD.encode(der);
        let lines = body
            .as_bytes()
            .chunks(64)
            .map(|line| std::str::from_utf8(line).expect("base64 is ASCII"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("-----BEGIN {label}-----\n{lines}\n-----END {label}-----\n")
    }

    /// One Ed25519 key in each PKCS#8 layout jsonwebtoken 9 (ring) signed
    /// with, and its public key as a PEM.
    struct KeyLayouts {
        /// RFC 8410 v1, as `openssl genpkey` and Node write it.
        v1: Vec<u8>,
        /// RFC 5958 v2, as ring 0.17 and aws-lc-rs write it: the public key
        /// under a primitive `[1]`.
        v2: Vec<u8>,
        /// The v2 layout ring 0.16 and earlier wrote: the public key as a BIT
        /// STRING under a constructed `[1]`.
        ring_0_16_v2: Vec<u8>,
        public_pem: String,
    }

    fn key_layouts() -> KeyLayouts {
        let v2 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .expect("generate key")
            .as_ref()
            .to_vec();
        assert_eq!(
            &v2[..5],
            &[0x30, 0x51, 0x02, 0x01, 0x01],
            "ring's v2 header"
        );
        assert_eq!(&v2[48..51], &[0x81, 0x21, 0x00], "ring's v2 public key tag");
        let public_key = Ed25519KeyPair::from_pkcs8(&v2)
            .expect("parse key")
            .public_key()
            .as_ref()
            .to_vec();
        let seed = &v2[16..48];
        let algorithm = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];

        let mut v1 = vec![0x30, 0x2e, 0x02, 0x01, 0x00];
        v1.extend_from_slice(&algorithm);
        v1.extend_from_slice(&[0x04, 0x22, 0x04, 0x20]);
        v1.extend_from_slice(seed);

        let mut ring_0_16_v2 = vec![0x30, 0x53, 0x02, 0x01, 0x01];
        ring_0_16_v2.extend_from_slice(&algorithm);
        ring_0_16_v2.extend_from_slice(&[0x04, 0x22, 0x04, 0x20]);
        ring_0_16_v2.extend_from_slice(seed);
        ring_0_16_v2.extend_from_slice(&[0xa1, 0x23, 0x03, 0x21, 0x00]);
        ring_0_16_v2.extend_from_slice(&public_key);

        let mut spki = vec![0x30, 0x2a];
        spki.extend_from_slice(&algorithm);
        spki.extend_from_slice(&[0x03, 0x21, 0x00]);
        spki.extend_from_slice(&public_key);

        KeyLayouts {
            v1,
            v2,
            ring_0_16_v2,
            public_pem: pem_block("PUBLIC KEY", &spki),
        }
    }

    // The deployed RUNTIME_SIGNING_PRIVATE_KEY may be in any of these
    // layouts, and every one of them signed under jsonwebtoken 9. AWS-LC
    // alone refuses the ring 0.16 one. jsonwebtoken 9 read the PEM with the
    // pem crate, which drops every whitespace character from the body, so a
    // key whose line breaks became spaces, tabs or bare carriage returns (a
    // value pasted into a one-line field) signed as well.
    #[test]
    fn every_pkcs8_layout_jsonwebtoken_9_signed_with_still_signs() {
        let keys = key_layouts();
        for (layout, der) in [
            ("v1", &keys.v1),
            ("v2", &keys.v2),
            ("ring 0.16 v2", &keys.ring_0_16_v2),
        ] {
            let pem = pem_block("PRIVATE KEY", der);
            for (spelling, private_pem) in [
                ("wrapped at 64", pem.clone()),
                ("line breaks as spaces", pem.trim_end().replace('\n', " ")),
                ("line breaks as tabs", pem.trim_end().replace('\n', "\t")),
                (
                    "line breaks as bare CRs",
                    pem.trim_end().replace('\n', "\r"),
                ),
            ] {
                let config =
                    crate::tests::build_app_config(&private_pem, &keys.public_pem, "layouts");
                let minted = mint_scoped_token(&config, request(600))
                    .unwrap_or_else(|error| panic!("{layout}, {spelling}: mint failed: {error:?}"));
                decode_scoped_token(&config, &minted.token, "layout token").unwrap_or_else(
                    |error| panic!("{layout}, {spelling}: token does not verify: {error:?}"),
                );
            }
        }
    }

    #[test]
    fn a_private_key_pem_whose_body_is_not_base64_is_refused() {
        let keys = key_layouts();
        let pem = pem_block("PRIVATE KEY", &keys.v2);
        let corrupted = pem.replacen("-----\n", "-----\n!", 1);
        assert_ne!(corrupted, pem);
        let config = crate::tests::build_app_config(&corrupted, &keys.public_pem, "corrupt");
        assert!(mint_scoped_token(&config, request(600)).is_err());
    }

    #[test]
    fn a_v2_key_carrying_another_keys_public_key_is_refused() {
        let keys = key_layouts();
        let other = key_layouts();
        let mut mismatched = keys.v2.clone();
        mismatched[51..].copy_from_slice(&other.v2[51..]);
        let config = crate::tests::build_app_config(
            &pem_block("PRIVATE KEY", &mismatched),
            &keys.public_pem,
            "pkcs8-mismatch",
        );
        assert!(mint_scoped_token(&config, request(600)).is_err());
    }

    fn signed_payload(token: &str) -> serde_json::Value {
        let payload = token.split('.').nth(1).expect("JWT payload segment");
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).expect("base64url payload"))
            .expect("JSON payload")
    }

    #[test]
    fn author_claims_are_signed_next_to_the_shared_claims() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-author",
        );
        let author = AuthorClaims {
            name: "Ada Lovelace".to_string(),
            email: "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev".to_string(),
        };
        let minted = mint_scoped_token_with_author(&config, request(600), Some(author.clone()))
            .expect("mint author token");
        let payload = signed_payload(&minted.token);
        assert_eq!(payload["author_name"], "Ada Lovelace");
        assert_eq!(payload["author_email"], author.email.as_str());
        assert_eq!(
            payload["scopes"],
            serde_json::json!(["git.read", "git.write"])
        );

        // The controller still decodes its own token with the shared claims.
        let claims = decode_scoped_token(&config, &minted.token, "author token")
            .expect("decode author token");
        assert_eq!(claims.scopes, vec!["git.read", "git.write"]);

        // Without an author the payload has no author fields at all.
        let plain = mint_scoped_token(&config, request(600)).expect("mint plain token");
        let payload = signed_payload(&plain.token);
        assert!(payload.get("author_name").is_none());
        assert!(payload.get("author_email").is_none());
        let plain = mint_scoped_token_with_author(&config, request(600), None)
            .expect("mint token without author");
        assert!(signed_payload(&plain.token).get("author_email").is_none());
    }

    fn unconnected_pool() -> crate::config::PgPool {
        let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
            "postgresql://ignored:ignored@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )
        .expect("connection manager");
        bb8::Pool::builder().max_size(1).build_unchecked(manager)
    }

    #[tokio::test]
    async fn no_author_claims_without_a_keyring_or_for_the_service_user() {
        // Never touches the database: both cases return before any lookup.
        let pool = unconnected_pool();
        let project_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "author-claims-without-keyring",
        );
        // Unset keyring, even with a hosted gateway: the controller runs and
        // origins keep their own identity.
        config.hosted_origin_endpoint = Some("http://127.0.0.1:9".to_string());
        config.author_pseudonym_keys = None;
        assert!(crate::author_identity::author_claims_for_user(
            &config,
            &pool,
            &project_id,
            &user_id
        )
        .await
        .is_none());

        config.author_pseudonym_keys = Some(
            crate::author_identity::AuthorPseudonymKeyring::parse(
                "v1:ERERERERERERERERERERERERERERERERERERERERERE=",
            )
            .expect("keyring"),
        );
        config.service_runtime_user_id = Some(user_id);
        assert!(crate::author_identity::author_claims_for_user(
            &config,
            &pool,
            &project_id,
            &user_id
        )
        .await
        .is_none());
    }
}
