//! Exercise ChatGPT audio renewal through private helpers without adding a live-endpoint override.
use super::*;
use axum::http::header;
use serial_test::serial;
use std::collections::VecDeque;
use std::sync::Mutex;

struct EnvGuard(Option<std::ffi::OsString>);
impl EnvGuard {
    fn refresh_endpoint(url: &str) -> Self {
        let previous = std::env::var_os("CODEX_REFRESH_TOKEN_URL_OVERRIDE");
        unsafe {
            std::env::set_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE", url);
        }
        Self(previous)
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.0 {
                Some(previous) => std::env::set_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE", previous),
                None => std::env::remove_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE"),
            }
        }
    }
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[derive(Clone)]
struct Mock {
    replies: Arc<Mutex<VecDeque<(StatusCode, String)>>>,
    authorizations: Arc<Mutex<Vec<String>>>,
}
async fn mock_handler(State(mock): State<Mock>, headers: HeaderMap) -> impl IntoResponse {
    mock.authorizations.lock().unwrap().push(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .into(),
    );
    mock.replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected extra audio/refresh request")
}
async fn mock(replies: Vec<(StatusCode, String)>) -> Result<(String, Mock, Server)> {
    let state = Mock {
        replies: Arc::new(Mutex::new(replies.into())),
        authorizations: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", listener.local_addr()?);
    let app = Router::new()
        .route("/", post(mock_handler))
        .with_state(state.clone());
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    Ok((url, state, server))
}
fn expired() -> (StatusCode, String) {
    (
        StatusCode::UNAUTHORIZED,
        json!({"error":{"code":"token_expired", "message":"private-audio-provider-detail"}})
            .to_string(),
    )
}
fn credentials(refresh: bool) -> Credentials {
    Credentials::ChatGpt {
        access_token: "inert-audio-old-access".into(),
        refresh_token: refresh.then(|| "inert-audio-refresh".into()),
        account_id: None,
        default_model: None,
        auth_path: None,
    }
}
#[derive(Clone, Copy, Debug)]
enum Audio {
    Speech,
    Transcription,
}
async fn send(
    audio: Audio,
    creds: &mut Credentials,
    url: &str,
) -> Result<reqwest::Response, AppError> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    match audio {
        Audio::Speech => {
            send_speech_request_with_retry(
                &http,
                creds,
                url,
                &json!({"model":"inert", "input":"hello"}),
                None,
                None,
            )
            .await
        }
        Audio::Transcription => {
            send_transcription_request_with_retry(
                &http,
                creds,
                url,
                Some("audio/wav"),
                Bytes::from_static(b"inert audio"),
                None,
                None,
            )
            .await
        }
    }
}
async fn assert_safe_terminal(error: AppError, status: StatusCode, code: &str) -> Result<()> {
    assert_eq!(error.status, status);
    let response = error.into_response();
    let bytes = axum::body::to_bytes(response.into_body(), 16_384).await?;
    let body: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(body["error"]["type"], "upstream_error");
    assert_eq!(body["error"]["code"], code);
    assert_eq!(body["error"]["retryable"], false);
    let body = body.to_string();
    for private in ["private-audio", "inert-audio", "127.0.0.1"] {
        assert!(!body.contains(private));
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn expired_audio_without_refresh_is_terminal_and_does_not_resend() -> Result<()> {
    for audio in [Audio::Speech, Audio::Transcription] {
        let (refresh_url, refresh, _refresh_server) = mock(vec![]).await?;
        let _env = EnvGuard::refresh_endpoint(&refresh_url);
        let (url, upstream, _server) = mock(vec![expired()]).await?;
        let error = send(audio, &mut credentials(false), &url)
            .await
            .unwrap_err();
        assert_safe_terminal(
            error,
            StatusCode::UNAUTHORIZED,
            "upstream_authentication_error",
        )
        .await?;
        assert_eq!(upstream.authorizations.lock().unwrap().len(), 1);
        assert!(refresh.authorizations.lock().unwrap().is_empty());
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn failed_audio_refresh_is_terminal_dependency_failure() -> Result<()> {
    for audio in [Audio::Speech, Audio::Transcription] {
        let (refresh_url, refresh, _refresh_server) = mock(vec![expired()]).await?;
        let _env = EnvGuard::refresh_endpoint(&refresh_url);
        let (url, upstream, _server) = mock(vec![expired()]).await?;
        let error = send(audio, &mut credentials(true), &url).await.unwrap_err();
        assert_safe_terminal(
            error,
            StatusCode::FAILED_DEPENDENCY,
            "upstream_credential_refresh_failed",
        )
        .await?;
        assert_eq!(upstream.authorizations.lock().unwrap().len(), 1);
        assert_eq!(refresh.authorizations.lock().unwrap().len(), 1);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn audio_refresh_resends_once_with_renewed_credentials_and_never_loops() -> Result<()> {
    for audio in [Audio::Speech, Audio::Transcription] {
        for recovered in [true, false] {
            let (refresh_url, refresh, _refresh_server) = mock(vec![(
                StatusCode::OK,
                json!({"access_token":"inert-audio-renewed-access"}).to_string(),
            )])
            .await?;
            let _env = EnvGuard::refresh_endpoint(&refresh_url);
            let final_reply = if recovered {
                (StatusCode::OK, "audio success".into())
            } else {
                expired()
            };
            let (url, upstream, _server) = mock(vec![expired(), final_reply]).await?;
            let result = send(audio, &mut credentials(true), &url).await;
            if recovered {
                assert_eq!(result.unwrap().text().await?, "audio success");
            } else {
                assert_safe_terminal(
                    result.unwrap_err(),
                    StatusCode::UNAUTHORIZED,
                    "upstream_authentication_error",
                )
                .await?;
            }
            assert_eq!(
                *upstream.authorizations.lock().unwrap(),
                [
                    "Bearer inert-audio-old-access",
                    "Bearer inert-audio-renewed-access"
                ]
            );
            assert_eq!(refresh.authorizations.lock().unwrap().len(), 1);
        }
    }
    Ok(())
}
