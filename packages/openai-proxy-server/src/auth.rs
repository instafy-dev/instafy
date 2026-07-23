use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR: &str = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Debug, Clone)]
pub enum Credentials {
    ApiKey {
        key: String,
        endpoint: Option<String>,
        default_model: Option<String>,
    },
    GeminiCodeAssist {
        access_token: String,
        project_id: String,
        endpoint: Option<String>,
        default_model: Option<String>,
    },
    ChatGpt {
        access_token: String,
        refresh_token: Option<String>,
        account_id: Option<String>,
        default_model: Option<String>,
        auth_path: Option<PathBuf>,
    },
}

impl Credentials {
    pub fn is_chatgpt(&self) -> bool {
        matches!(self, Self::ChatGpt { .. })
    }

    pub fn bearer(&self) -> &str {
        match self {
            Self::ApiKey { key, .. } => key,
            Self::GeminiCodeAssist { access_token, .. } => access_token,
            Self::ChatGpt { access_token, .. } => access_token,
        }
    }

    pub fn endpoint(&self) -> &str {
        match self {
            Self::ApiKey {
                endpoint: Some(endpoint),
                ..
            } => endpoint.as_str(),
            Self::ApiKey { .. } => override_endpoint(
                "CODEX_OPENAI_ENDPOINT",
                "https://api.openai.com/v1/responses",
            ),
            Self::GeminiCodeAssist {
                endpoint: Some(endpoint),
                ..
            } => endpoint.as_str(),
            Self::GeminiCodeAssist { .. } => override_endpoint(
                "CODEX_GEMINI_CODE_ASSIST_ENDPOINT",
                "https://cloudcode-pa.googleapis.com",
            ),
            Self::ChatGpt { .. } => chatgpt_upstream_endpoint(),
        }
    }

    pub fn default_model(&self) -> Option<&str> {
        match self {
            Self::ApiKey {
                default_model: Some(model),
                ..
            } => Some(model.as_str()),
            Self::GeminiCodeAssist {
                default_model: Some(model),
                ..
            } => Some(model.as_str()),
            Self::ChatGpt {
                default_model: Some(model),
                ..
            } => Some(model.as_str()),
            _ => None,
        }
    }

    pub fn gemini_code_assist_project_id(&self) -> Option<&str> {
        match self {
            Self::GeminiCodeAssist { project_id, .. } => Some(project_id.as_str()),
            _ => None,
        }
    }

    pub fn chatgpt_account_id(&self) -> Option<&str> {
        match self {
            Self::ChatGpt {
                account_id: Some(id),
                ..
            } => Some(id.as_str()),
            _ => None,
        }
    }

    pub fn reload_chatgpt_access_token_from_auth_path(&mut self) -> Result<bool> {
        let Self::ChatGpt {
            access_token,
            refresh_token,
            account_id,
            auth_path: Some(auth_path),
            ..
        } = self
        else {
            return Ok(false);
        };
        let auth_path = auth_path.clone();

        let contents = fs::read_to_string(&auth_path)
            .with_context(|| format!("failed to read auth file at {}", auth_path.display()))?;
        let auth: AuthFile = serde_json::from_str(&contents)
            .with_context(|| format!("failed to parse auth.json at {}", auth_path.display()))?;
        let tokens = auth
            .tokens
            .ok_or_else(|| anyhow!("auth.json does not contain tokens; run `codex login`"))?;
        let updated_access_token = normalize_optional_field(tokens.access_token.as_deref())
            .ok_or_else(|| anyhow!("auth.json tokens missing access_token; retry `codex login`"))?;

        let mut changed = false;
        if access_token != &updated_access_token {
            *access_token = updated_access_token;
            changed = true;
        }
        if let Some(updated_refresh_token) =
            normalize_optional_field(tokens.refresh_token.as_deref())
            && refresh_token.as_deref() != Some(updated_refresh_token.as_str())
        {
            *refresh_token = Some(updated_refresh_token);
            changed = true;
        }
        if let Some(updated_account_id) = normalize_optional_field(tokens.account_id.as_deref())
            && account_id.as_deref() != Some(updated_account_id.as_str())
        {
            *account_id = Some(updated_account_id);
            changed = true;
        }

        Ok(changed)
    }

    pub async fn refresh_chatgpt_access_token(&mut self, client: &reqwest::Client) -> Result<bool> {
        let Self::ChatGpt {
            access_token,
            refresh_token,
            auth_path,
            ..
        } = self
        else {
            return Ok(false);
        };
        let auth_path = auth_path.clone();

        let Some(refresh_token_value) = normalize_optional_field(refresh_token.as_deref()) else {
            return Ok(false);
        };

        let refresh_request = RefreshRequest {
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refresh_token_value,
            scope: "openid profile email",
        };

        let response = client
            .post(refresh_token_endpoint())
            .header("Content-Type", "application/json")
            .json(&refresh_request)
            .send()
            .await
            .context("failed to send ChatGPT token refresh request")?;

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<empty>".to_string());
        if !status.is_success() {
            bail!("failed to refresh ChatGPT token: {} {}", status, body);
        }

        let refresh_response: RefreshResponse = serde_json::from_str(&body)
            .context("failed to parse ChatGPT token refresh response")?;
        let new_access_token =
            normalize_optional_field(refresh_response.access_token.as_deref())
                .ok_or_else(|| anyhow!("ChatGPT token refresh response missing access_token"))?;

        *access_token = new_access_token;
        if let Some(new_refresh_token) =
            normalize_optional_field(refresh_response.refresh_token.as_deref())
        {
            *refresh_token = Some(new_refresh_token);
        }

        if let Some(path) = auth_path.as_ref() {
            persist_refreshed_chatgpt_tokens(path, &refresh_response)?;
        }

        Ok(true)
    }
}

fn override_endpoint(env_key: &str, default: &'static str) -> &'static str {
    match env::var(env_key) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                default
            } else {
                Box::leak(trimmed.to_string().into_boxed_str())
            }
        }
        Err(_) => default,
    }
}

fn chatgpt_upstream_endpoint() -> &'static str {
    match env::var("CODEX_PROXY_CHATGPT_ENDPOINT") {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                "https://chatgpt.com/backend-api/codex/responses"
            } else {
                Box::leak(trimmed.to_string().into_boxed_str())
            }
        }
        Err(_) => "https://chatgpt.com/backend-api/codex/responses",
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct AuthFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", skip_serializing_if = "Option::is_none")]
    openai_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_refresh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokens: Option<TokenData>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct TokenData {
    #[serde(rename = "id_token", default, skip_serializing_if = "Option::is_none")]
    id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(
        rename = "refresh_token",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct RefreshRequest {
    client_id: &'static str,
    grant_type: &'static str,
    refresh_token: String,
    scope: &'static str,
}

pub fn response_indicates_chatgpt_token_expired(status: StatusCode, body: &str) -> bool {
    if status != StatusCode::UNAUTHORIZED {
        return false;
    }

    // Provider error payload matching only. Do not infer auth refresh from user prompt text.
    let lowered = body.to_ascii_lowercase();
    lowered.contains("token_expired")
        || lowered.contains("token_invalidated")
        || lowered.contains("token_revoked")
        || lowered.contains("authentication token is expired")
        || lowered.contains("authentication token has been invalidated")
        || lowered.contains("access token expired")
        || lowered.contains("invalidated oauth token")
}

pub fn load_credentials(explicit: Option<&Path>) -> Result<Credentials> {
    if let Some(key) = read_openai_api_key_from_env() {
        return Ok(Credentials::ApiKey {
            key,
            endpoint: None,
            default_model: None,
        });
    }

    let auth_path = resolve_auth_path(explicit)?;
    let contents = fs::read_to_string(&auth_path)
        .with_context(|| format!("failed to read auth file at {}", auth_path.display()))?;

    let auth: AuthFile = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse auth.json at {}", auth_path.display()))?;

    let auth_mode = normalize_optional_field(auth.auth_mode.as_deref());
    let file_api_key = auth
        .openai_api_key
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let tokens = auth
        .tokens
        .ok_or_else(|| anyhow!("auth.json does not contain tokens; run `codex login`"))?;

    let access_token = tokens
        .access_token
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    if auth_mode.as_deref() == Some("chatgpt") {
        if let Some(access_token) = access_token.as_ref() {
            return Ok(Credentials::ChatGpt {
                access_token: access_token.clone(),
                refresh_token: normalize_optional_field(tokens.refresh_token.as_deref()),
                account_id: tokens.account_id.and_then(|s| {
                    let trimmed = s.trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                }),
                default_model: None,
                auth_path: Some(auth_path),
            });
        }
        if let Some(key) = file_api_key {
            return Ok(Credentials::ApiKey {
                key,
                endpoint: None,
                default_model: None,
            });
        }
        return Err(anyhow!(
            "auth.json tokens missing access_token; retry `codex login`"
        ));
    }

    if let Some(key) = file_api_key {
        return Ok(Credentials::ApiKey {
            key,
            endpoint: None,
            default_model: None,
        });
    }

    let access_token = access_token
        .ok_or_else(|| anyhow!("auth.json tokens missing access_token; retry `codex login`"))?;

    Ok(Credentials::ChatGpt {
        access_token,
        refresh_token: normalize_optional_field(tokens.refresh_token.as_deref()),
        account_id: tokens.account_id.and_then(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }),
        default_model: None,
        auth_path: Some(auth_path),
    })
}

fn read_openai_api_key_from_env() -> Option<String> {
    env::var("OPENAI_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn resolve_auth_path(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }

    if let Ok(path) = env::var("CODEX_AUTH_PATH") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    let home = if let Ok(codex_home) = env::var("CODEX_HOME") {
        PathBuf::from(codex_home)
    } else {
        let home_dir = env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| anyhow!("$HOME is not set; set CODEX_HOME or CODEX_AUTH_PATH"))?;
        home_dir.join(".codex")
    };

    let auth_path = home.join("auth.json");
    if !auth_path.exists() {
        bail!("expected auth.json at {}", auth_path.display());
    }
    Ok(auth_path)
}

fn normalize_optional_field(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn refresh_token_endpoint() -> String {
    env::var(REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR).unwrap_or_else(|_| REFRESH_TOKEN_URL.to_string())
}

fn current_timestamp_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn persist_refreshed_chatgpt_tokens(auth_path: &Path, refreshed: &RefreshResponse) -> Result<()> {
    let contents = fs::read_to_string(auth_path)
        .with_context(|| format!("failed to read auth file at {}", auth_path.display()))?;
    let mut auth: AuthFile = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse auth.json at {}", auth_path.display()))?;

    let tokens = auth.tokens.get_or_insert_with(|| TokenData {
        id_token: None,
        access_token: None,
        refresh_token: None,
        account_id: None,
    });
    if let Some(id_token) = normalize_optional_field(refreshed.id_token.as_deref()) {
        tokens.id_token = Some(id_token);
    }
    if let Some(access_token) = normalize_optional_field(refreshed.access_token.as_deref()) {
        tokens.access_token = Some(access_token);
    }
    if let Some(refresh_token) = normalize_optional_field(refreshed.refresh_token.as_deref()) {
        tokens.refresh_token = Some(refresh_token);
    }
    auth.last_refresh = Some(current_timestamp_rfc3339());

    let serialized = serde_json::to_string_pretty(&auth)
        .with_context(|| format!("failed to serialize auth.json at {}", auth_path.display()))?;
    fs::write(auth_path, serialized)
        .with_context(|| format!("failed to write auth.json at {}", auth_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut perms = fs::metadata(auth_path)
            .with_context(|| format!("failed to read permissions for {}", auth_path.display()))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(auth_path, perms).with_context(|| {
            format!(
                "failed to set auth.json permissions at {}",
                auth_path.display()
            )
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::post};
    use serde_json::json;
    use serial_test::serial;
    use tokio::net::TcpListener;
    use uuid::Uuid;

    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<str>) -> Self {
            let original = env::var(key).ok();
            unsafe {
                env::set_var(key, value.as_ref());
            }
            Self { key, original }
        }

        fn remove(key: &'static str) -> Self {
            let original = env::var(key).ok();
            unsafe {
                env::remove_var(key);
            }
            Self { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => unsafe {
                    env::set_var(self.key, value);
                },
                None => unsafe {
                    env::remove_var(self.key);
                },
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn refresh_chatgpt_access_token_updates_auth_json() -> Result<()> {
        let _api_key_guard = EnvGuard::remove("OPENAI_API_KEY");

        async fn handle_refresh() -> Json<serde_json::Value> {
            Json(json!({
                "id_token": "new-id-token",
                "access_token": "new-access-token",
                "refresh_token": "new-refresh-token"
            }))
        }

        let app = Router::new().route("/oauth/token", post(handle_refresh));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("refresh stub server");
        });

        let auth_dir = env::temp_dir().join(format!("instafy-proxy-auth-{}", Uuid::new_v4()));
        fs::create_dir_all(&auth_dir)?;
        let auth_path = auth_dir.join("auth.json");
        let initial = AuthFile {
            auth_mode: Some("chatgpt".to_string()),
            openai_api_key: None,
            last_refresh: Some("2026-04-05T11:05:51.082073Z".to_string()),
            tokens: Some(TokenData {
                id_token: Some("old-id-token".to_string()),
                access_token: Some("old-access-token".to_string()),
                refresh_token: Some("old-refresh-token".to_string()),
                account_id: Some("acct_123".to_string()),
            }),
        };
        fs::write(&auth_path, serde_json::to_string_pretty(&initial)?)?;

        let _endpoint_guard = EnvGuard::set(
            REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR,
            format!("http://{}/oauth/token", addr),
        );

        let mut credentials = load_credentials(Some(&auth_path))?;
        let client = reqwest::Client::new();
        assert!(credentials.refresh_chatgpt_access_token(&client).await?);
        let _ = credentials.reload_chatgpt_access_token_from_auth_path()?;

        match credentials {
            Credentials::ChatGpt {
                access_token,
                refresh_token,
                account_id,
                ..
            } => {
                assert_eq!(access_token, "new-access-token");
                assert_eq!(refresh_token.as_deref(), Some("new-refresh-token"));
                assert_eq!(account_id.as_deref(), Some("acct_123"));
            }
            other => panic!("expected chatgpt credentials, got {other:?}"),
        }

        let updated: AuthFile = serde_json::from_str(&fs::read_to_string(&auth_path)?)?;
        let updated_tokens = updated.tokens.expect("updated tokens");
        assert_eq!(
            updated_tokens.access_token.as_deref(),
            Some("new-access-token")
        );
        assert_eq!(
            updated_tokens.refresh_token.as_deref(),
            Some("new-refresh-token")
        );
        assert_eq!(updated_tokens.account_id.as_deref(), Some("acct_123"));
        assert!(updated.last_refresh.is_some());

        server.abort();
        let _ = fs::remove_file(&auth_path);
        let _ = fs::remove_dir_all(&auth_dir);
        Ok(())
    }

    #[test]
    fn detects_token_expired_unauthorized_responses() {
        assert!(response_indicates_chatgpt_token_expired(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"code":"token_expired","message":"Provided authentication token is expired."}}"#,
        ));
        assert!(!response_indicates_chatgpt_token_expired(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"code":"invalid_request"}}"#,
        ));
        assert!(!response_indicates_chatgpt_token_expired(
            StatusCode::BAD_GATEWAY,
            r#"{"error":{"code":"token_expired"}}"#,
        ));
        assert!(response_indicates_chatgpt_token_expired(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"code":"token_revoked","message":"Encountered invalidated oauth token for user"}}"#,
        ));
        assert!(response_indicates_chatgpt_token_expired(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"code":"token_invalidated","message":"Your authentication token has been invalidated. Please try signing in again."}}"#,
        ));
    }

    #[test]
    #[serial]
    fn chatgpt_auth_mode_prefers_tokens_over_embedded_api_key() -> Result<()> {
        let _api_key_guard = EnvGuard::remove("OPENAI_API_KEY");

        let auth_dir = env::temp_dir().join(format!("instafy-proxy-auth-{}", Uuid::new_v4()));
        fs::create_dir_all(&auth_dir)?;
        let auth_path = auth_dir.join("auth.json");
        let auth = AuthFile {
            auth_mode: Some("chatgpt".to_string()),
            openai_api_key: Some("sk-test-restricted".to_string()),
            last_refresh: Some("2026-04-05T11:05:51.082073Z".to_string()),
            tokens: Some(TokenData {
                id_token: Some("id-token".to_string()),
                access_token: Some("chatgpt-access-token".to_string()),
                refresh_token: Some("chatgpt-refresh-token".to_string()),
                account_id: Some("acct_123".to_string()),
            }),
        };
        fs::write(&auth_path, serde_json::to_string_pretty(&auth)?)?;

        let credentials = load_credentials(Some(&auth_path))?;
        match credentials {
            Credentials::ChatGpt {
                access_token,
                refresh_token,
                account_id,
                ..
            } => {
                assert_eq!(access_token, "chatgpt-access-token");
                assert_eq!(refresh_token.as_deref(), Some("chatgpt-refresh-token"));
                assert_eq!(account_id.as_deref(), Some("acct_123"));
            }
            other => panic!("expected chatgpt credentials, got {other:?}"),
        }

        let _ = fs::remove_file(&auth_path);
        let _ = fs::remove_dir_all(&auth_dir);
        Ok(())
    }
}
