use std::path::PathBuf;
use std::sync::Arc;

use axum::{routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::{runtime, AppState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevProjectEntry {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegistryEntry {
    id: String,
    #[serde(default)]
    label: Option<String>,
}

pub(crate) async fn list_projects(registry_path: PathBuf) -> Json<Vec<DevProjectEntry>> {
    let data = tokio::fs::read_to_string(&registry_path).await;
    match data {
        Ok(contents) => match serde_json::from_str::<Vec<RegistryEntry>>(&contents) {
            Ok(entries) => {
                let mapped = entries
                    .into_iter()
                    .filter(|entry| !entry.id.trim().is_empty())
                    .map(|entry| DevProjectEntry {
                        id: entry.id,
                        label: entry.label,
                    })
                    .collect();
                Json(mapped)
            }
            Err(error) => {
                warn!(
                    path = %registry_path.display(),
                    %error,
                    "failed to parse runtime project registry"
                );
                Json(Vec::new())
            }
        },
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    path = %registry_path.display(),
                    %error,
                    "failed to read runtime project registry"
                );
            }
            Json(Vec::new())
        }
    }
}

pub(crate) fn router(registry_path: Option<PathBuf>) -> Router<AppState> {
    let mut router = Router::new().route(
        "/dev/projects/:project_id/runtime/offline",
        post(runtime::runtime_mark_offline),
    );

    if let Some(path) = registry_path {
        let shared_path = Arc::new(path);
        router = router.route(
            "/dev/projects",
            get({
                let shared = Arc::clone(&shared_path);
                move || {
                    let path = Arc::clone(&shared);
                    async move { list_projects((*path).clone()).await }
                }
            }),
        );
    }

    router
}
