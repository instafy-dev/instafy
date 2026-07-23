use std::collections::{HashMap, HashSet};
use std::time::{Duration as StdDuration, Instant};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use once_cell::sync::Lazy;
use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::{
    bad_request, ensure_project_access, internal_error, load_project_record, unauthorized,
    ApiError, AppState,
};

const PLAYBOOKS_SKILLS_API_URL: &str = "https://playbooks.com/api/skills";
const PLAYBOOKS_DISCOVERY_ENABLED_ENV: &str = "SKILLS_DISCOVERY_ENABLE_PLAYBOOKS";
const OPENCLAW_AWESOME_README_URL: &str =
    "https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md";
const OPENCLAW_SKILLS_URL_PREFIX: &str = "https://github.com/openclaw/skills/tree/main/";
const OPENCLAW_REPO_OWNER: &str = "openclaw";
const OPENCLAW_REPO_NAME: &str = "skills";
const OPENCLAW_REPO_FULL_NAME: &str = "openclaw/skills";
const COMPOSIO_REPO_OWNER: &str = "ComposioHQ";
const COMPOSIO_REPO_NAME: &str = "awesome-claude-skills";
const COMPOSIO_REPO_FULL_NAME: &str = "ComposioHQ/awesome-claude-skills";
const COMPOSIO_REPO_BRANCH: &str = "master";
const COMPOSIO_TREE_API_URL: &str =
    "https://api.github.com/repos/ComposioHQ/awesome-claude-skills/git/trees/master?recursive=1";
const SKILL_FILENAME: &str = "SKILL.md";
const GITHUB_CODE_SEARCH_API_URL: &str = "https://api.github.com/search/code";
const GITHUB_REPO_SEARCH_API_URL: &str = "https://api.github.com/search/repositories";
const GITHUB_USER_AGENT: &str = "instafy-runtime-controller/skills-discovery";

const DISCOVERY_HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_CACHE_TTL: StdDuration = StdDuration::from_secs(60 * 5);
const OPENCLAW_CACHE_TTL: StdDuration = StdDuration::from_secs(60 * 60 * 6);
const INSTALL_SOURCE_CACHE_TTL: StdDuration = StdDuration::from_secs(60 * 60 * 6);
const INSTALL_SOURCE_HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const PLAYBOOKS_INSTALL_VALIDATION_LIMIT: usize = 12;

const DEFAULT_RESULT_LIMIT: usize = 20;
const MAX_RESULT_LIMIT: usize = 40;
const MAX_QUERY_LENGTH_CHARS: usize = 120;
const MAX_GITHUB_REPO_SHIM_REPOS: usize = 6;
const MAX_GITHUB_REPO_SHIM_SKILLS_PER_REPO: usize = 2;
const MAX_GITHUB_TREE_SCAN_ENTRIES: usize = 20_000;
const OPENCLAW_PRIORITY_CATEGORIES: &[&str] = &[
    "Browser & Automation",
    "Web & Frontend Development",
    "Coding Agents & IDEs",
    "DevOps & Cloud",
];
const OPENCLAW_POSITIVE_KEYWORDS: &[&str] = &[
    "playwright",
    "browser",
    "web",
    "frontend",
    "e2e",
    "test",
    "testing",
    "github",
    "git",
    "automation",
    "developer",
    "coding",
    "mcp",
    "codex",
];
const OPENCLAW_NEGATIVE_KEYWORDS: &[&str] = &[
    "captcha",
    "crypto",
    "trading",
    "marketing",
    "advertising",
    "whatsapp",
    "finance",
];

static DISCOVERY_CACHE: Lazy<RwLock<HashMap<String, CachedDiscoveryEntry>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static OPENCLAW_CATALOG_CACHE: Lazy<RwLock<Option<CachedOpenClawCatalog>>> =
    Lazy::new(|| RwLock::new(None));
static COMPOSIO_CATALOG_CACHE: Lazy<RwLock<Option<CachedComposioCatalog>>> =
    Lazy::new(|| RwLock::new(None));
static INSTALL_SOURCE_CACHE: Lazy<RwLock<HashMap<String, CachedInstallSourceEntry>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/skills/discover",
        get(discover_skills),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsDiscoverQuery {
    q: Option<String>,
    sources: Option<String>,
    limit: Option<usize>,
    official_only: Option<bool>,
    language: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsDiscoverResponse {
    success: bool,
    query: String,
    #[serde(default)]
    results: Vec<DiscoveredSkill>,
    #[serde(default)]
    lane_counts: DiscoveryLaneCounts,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    curated_categories: Vec<DiscoveryCategoryCount>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
    cached: bool,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryLaneCounts {
    curated: usize,
    registry: usize,
    long_tail: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryCategoryCount {
    name: String,
    count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveredSkill {
    id: String,
    title: String,
    description: String,
    lane: String,
    provenance: String,
    is_installable: bool,
    source: String,
    source_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_official: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stars: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_grade: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_score: Option<i64>,
}

#[derive(Debug, Clone)]
struct CachedDiscoveryEntry {
    expires_at: Instant,
    response: SkillsDiscoverResponse,
}

#[derive(Debug, Clone)]
struct CachedOpenClawCatalog {
    expires_at: Instant,
    entries: Vec<CuratedCatalogEntry>,
}

#[derive(Debug, Clone)]
struct CachedComposioCatalog {
    expires_at: Instant,
    entries: Vec<CuratedCatalogEntry>,
}

#[derive(Debug, Clone)]
struct CachedInstallSourceEntry {
    expires_at: Instant,
    resolved_source: Option<String>,
}

#[derive(Debug, Clone)]
struct CuratedCatalogEntry {
    title: String,
    slug: String,
    description: String,
    category: Option<String>,
    repo_full_name: String,
    provenance: String,
    source: String,
    stars: Option<u64>,
}

#[derive(Debug, Clone)]
struct GitHubInstallSource {
    owner: String,
    repo: String,
    branch: String,
    skill_file_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteFileStatus {
    Exists,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum DiscoverySource {
    Playbooks,
    Github,
}

impl DiscoverySource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Playbooks => "playbooks",
            Self::Github => "github",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiscoveryLane {
    Curated,
    Registry,
    LongTail,
}

impl DiscoveryLane {
    fn as_str(self) -> &'static str {
        match self {
            Self::Curated => "curated",
            Self::Registry => "registry",
            Self::LongTail => "long_tail",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PlaybooksMode {
    Lexical,
    Semantic,
}

impl PlaybooksMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lexical => "lexical",
            Self::Semantic => "semantic",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybooksApiResponse {
    success: bool,
    #[serde(default)]
    data: Vec<PlaybooksSkillRecord>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybooksSkillRecord {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    short_description: Option<String>,
    #[serde(default)]
    repo_owner: Option<String>,
    #[serde(default)]
    repo_name: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    skill_slug: Option<String>,
    #[serde(default)]
    primary_language: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    is_official: Option<bool>,
    #[serde(default)]
    stars: Option<u64>,
    #[serde(default)]
    safety_risk_level: Option<String>,
    #[serde(default)]
    health_grade: Option<String>,
    #[serde(default)]
    health_score: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GitHubCodeSearchResponse {
    #[serde(default)]
    items: Vec<GitHubCodeSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubCodeSearchItem {
    #[serde(default)]
    path: String,
    #[serde(default)]
    html_url: Option<String>,
    repository: GitHubRepositoryRecord,
}

#[derive(Debug, Deserialize)]
struct GitHubRepositorySearchResponse {
    #[serde(default)]
    items: Vec<GitHubRepositoryRecord>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitHubRepositoryRecord {
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    owner: Option<GitHubOwnerRecord>,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    stargazers_count: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct GitHubOwnerRecord {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeResponse {
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    tree: Vec<GitHubTreeEntry>,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeEntry {
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default)]
    path: String,
}

async fn discover_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Query(query): Query<SkillsDiscoverQuery>,
) -> Result<Json<SkillsDiscoverResponse>, (StatusCode, Json<ApiError>)> {
    let project_id =
        Uuid::parse_str(project_id_raw.trim()).map_err(|_| bad_request("invalid project id"))?;

    let context = authenticate_request(&state.config, &headers, None).await?;
    if context.user_id.is_none() && !context.is_service_role {
        return Err(unauthorized("user session required"));
    }

    if !state.config.dev_mode && !context.is_service_role {
        if let Some(user_id) = context.user_id {
            state
                .rate_limiter
                .enforce(
                    format!("skills:discover:user:{user_id}"),
                    30,
                    StdDuration::from_secs(60),
                )
                .await
                .map_err(|limit| {
                    crate::too_many_requests(format!(
                        "Too many skill discovery requests. Try again in {}s.",
                        limit.retry_after.as_secs().max(1)
                    ))
                })?;
        }
    }

    {
        let mut connection = state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        let transaction = connection
            .transaction()
            .await
            .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
        let project = load_project_record(&transaction, &project_id).await?;
        ensure_project_access(&transaction, &project, &context, None).await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to finalize project authorization: {error}"))
        })?;
    }

    let query_text = query.q.unwrap_or_default().trim().to_string();
    if query_text.chars().count() > MAX_QUERY_LENGTH_CHARS {
        return Err(bad_request(format!(
            "query is too long (max {MAX_QUERY_LENGTH_CHARS} characters)"
        )));
    }

    let playbooks_enabled = playbooks_discovery_enabled();
    let sources = parse_sources(query.sources.as_deref(), playbooks_enabled);
    let mode = parse_mode(query.mode.as_deref());
    let result_limit = query
        .limit
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let official_only = query.official_only.unwrap_or(false);
    let language = query
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let cache_key = build_cache_key(
        query_text.as_str(),
        &sources,
        result_limit,
        official_only,
        language.as_deref(),
        mode,
    );
    if let Some(mut cached) = read_discovery_cache(cache_key.as_str()).await {
        cached.cached = true;
        return Ok(Json(cached));
    }

    let actor_user_id = context.user_id;
    let use_playbooks = sources.contains(&DiscoverySource::Playbooks);
    let use_github = sources.contains(&DiscoverySource::Github);

    let query_for_playbooks = query_text.clone();
    let query_for_openclaw = query_text.clone();
    let language_for_playbooks = language.clone();
    let playbooks_limit = (result_limit * 2).clamp(1, MAX_RESULT_LIMIT);
    let github_limit = (result_limit * 2).clamp(1, MAX_RESULT_LIMIT);

    let playbooks_task = async {
        if !use_playbooks {
            return Ok(None);
        }
        if query_for_playbooks.trim().is_empty() {
            return Ok(Some(Vec::new()));
        }
        fetch_playbooks_results(
            &state,
            query_for_playbooks.as_str(),
            playbooks_limit,
            official_only,
            language_for_playbooks.as_deref(),
            mode,
        )
        .await
        .map(Some)
    };

    let github_task = async {
        if !use_github {
            return Ok(None);
        }
        fetch_github_catalog_results(
            &state,
            actor_user_id.as_ref(),
            query_for_openclaw.as_str(),
            github_limit,
        )
        .await
        .map(Some)
    };

    let (playbooks_result, github_result) = tokio::join!(playbooks_task, github_task);

    let mut merged_results = Vec::new();
    let mut warnings = Vec::new();

    match playbooks_result {
        Ok(Some(items)) => merged_results.extend(items),
        Ok(None) => {}
        Err(error) => warnings.push(format!("Playbooks source unavailable: {error}")),
    }
    match github_result {
        Ok(Some(items)) => merged_results.extend(items),
        Ok(None) => {}
        Err(error) => warnings.push(format!("GitHub source unavailable: {error}")),
    }

    let ranked_results = dedupe_and_rank(merged_results, query_text.as_str(), result_limit);
    let lane_counts = compute_lane_counts(&ranked_results);
    let curated_categories = if use_github {
        let (catalog_entries, catalog_errors) =
            load_curated_github_catalogs(&state, actor_user_id.as_ref()).await;
        for error in catalog_errors {
            warnings.push(format!("GitHub curated source unavailable: {error}"));
        }
        compute_curated_category_counts(&catalog_entries, query_text.as_str())
    } else {
        Vec::new()
    };
    let response = SkillsDiscoverResponse {
        success: true,
        query: query_text,
        results: ranked_results,
        lane_counts,
        curated_categories,
        warnings,
        cached: false,
    };

    write_discovery_cache(cache_key, &response).await;
    Ok(Json(response))
}

fn playbooks_discovery_enabled() -> bool {
    match std::env::var(PLAYBOOKS_DISCOVERY_ENABLED_ENV)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
    {
        Some(value) if value == "1" || value == "true" || value == "yes" || value == "on" => true,
        _ => false,
    }
}

fn parse_sources(raw_sources: Option<&str>, playbooks_enabled: bool) -> Vec<DiscoverySource> {
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();

    let source_values = raw_sources
        .unwrap_or("all")
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .collect::<Vec<String>>();

    let mut push_source = |source: DiscoverySource| {
        if seen.insert(source) {
            parsed.push(source);
        }
    };

    for value in source_values {
        match value.as_str() {
            "" => {}
            "all" => {
                if playbooks_enabled {
                    push_source(DiscoverySource::Playbooks);
                }
                push_source(DiscoverySource::Github);
            }
            "playbooks" => {
                if playbooks_enabled {
                    push_source(DiscoverySource::Playbooks);
                }
            }
            "github" => push_source(DiscoverySource::Github),
            _ => {}
        }
    }

    if parsed.is_empty() {
        vec![DiscoverySource::Github]
    } else {
        parsed
    }
}

fn parse_mode(raw_mode: Option<&str>) -> PlaybooksMode {
    match raw_mode
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("semantic") => PlaybooksMode::Semantic,
        _ => PlaybooksMode::Lexical,
    }
}

fn build_cache_key(
    query: &str,
    sources: &[DiscoverySource],
    limit: usize,
    official_only: bool,
    language: Option<&str>,
    mode: PlaybooksMode,
) -> String {
    let mut source_keys = sources
        .iter()
        .map(|source| source.as_str())
        .collect::<Vec<&str>>();
    source_keys.sort_unstable();

    let normalized_query = query.trim().to_ascii_lowercase();
    let normalized_language = language.unwrap_or("").trim().to_ascii_lowercase();

    format!(
        "q={normalized_query}|sources={}|limit={limit}|official={official_only}|language={normalized_language}|mode={}",
        source_keys.join(","),
        mode.as_str()
    )
}

async fn read_discovery_cache(cache_key: &str) -> Option<SkillsDiscoverResponse> {
    let now = Instant::now();
    {
        let cache = DISCOVERY_CACHE.read().await;
        if let Some(entry) = cache.get(cache_key) {
            if entry.expires_at > now {
                return Some(entry.response.clone());
            }
        }
    }

    let mut cache = DISCOVERY_CACHE.write().await;
    cache.retain(|_, entry| entry.expires_at > now);
    cache.get(cache_key).map(|entry| entry.response.clone())
}

async fn write_discovery_cache(cache_key: String, response: &SkillsDiscoverResponse) {
    let mut cache = DISCOVERY_CACHE.write().await;
    let now = Instant::now();
    cache.retain(|_, entry| entry.expires_at > now);

    let mut cached_response = response.clone();
    cached_response.cached = false;
    cache.insert(
        cache_key,
        CachedDiscoveryEntry {
            expires_at: now + DISCOVERY_CACHE_TTL,
            response: cached_response,
        },
    );
}

async fn fetch_playbooks_results(
    state: &AppState,
    query: &str,
    limit: usize,
    official_only: bool,
    language: Option<&str>,
    mode: PlaybooksMode,
) -> Result<Vec<DiscoveredSkill>, String> {
    let mut url = Url::parse(PLAYBOOKS_SKILLS_API_URL)
        .map_err(|error| format!("invalid Playbooks URL: {error}"))?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("search", query.trim());
        query_pairs.append_pair("limit", &limit.to_string());
        query_pairs.append_pair("mode", mode.as_str());
        if official_only {
            query_pairs.append_pair("official", "true");
        }
        if let Some(value) = language.map(str::trim).filter(|value| !value.is_empty()) {
            query_pairs.append_pair("language", value);
        }
    }

    let request = state
        .http_client
        .get(url.clone())
        .header("accept", "application/json");

    let response = timeout(DISCOVERY_HTTP_TIMEOUT, request.send())
        .await
        .map_err(|_| "Playbooks request timed out".to_string())?
        .map_err(|error| format!("Playbooks request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("Playbooks returned HTTP {status}"));
        }
        return Err(format!("Playbooks returned HTTP {status}: {detail}"));
    }

    let payload = response
        .json::<PlaybooksApiResponse>()
        .await
        .map_err(|error| format!("Playbooks response decoding failed: {error}"))?;
    if !payload.success {
        return Err(payload
            .error
            .unwrap_or_else(|| "Playbooks search returned unsuccessful response".to_string()));
    }

    let mut out = Vec::new();
    for record in payload.data {
        let name = record
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Unnamed skill")
            .to_string();
        let description = record
            .short_description
            .as_deref()
            .or(record.description.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("No description provided.")
            .to_string();
        let description = truncate_text(description.as_str(), 200);

        let repo_owner = record
            .repo_owner
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let repo_name = record
            .repo_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let skill_slug = record
            .skill_slug
            .as_deref()
            .and_then(normalize_skill_name)
            .or_else(|| normalize_skill_name(name.as_str()));
        let install_source = build_playbooks_install_source(
            repo_owner.as_deref(),
            repo_name.as_deref(),
            record.path.as_deref(),
        );
        let homepage = build_playbooks_homepage(
            repo_owner.as_deref(),
            repo_name.as_deref(),
            skill_slug.as_deref(),
        );
        let repo = match (repo_owner.as_deref(), repo_name.as_deref()) {
            (Some(owner), Some(repo_name)) => Some(format!("{owner}/{repo_name}")),
            _ => None,
        };
        let fallback_slug =
            normalize_skill_name(name.as_str()).unwrap_or_else(|| "skill".to_string());
        let id_slug = skill_slug.as_deref().unwrap_or(fallback_slug.as_str());
        let id = format!(
            "playbooks:{}:{}:{}",
            repo_owner.as_deref().unwrap_or("unknown-owner"),
            repo_name.as_deref().unwrap_or("unknown-repo"),
            id_slug
        );

        out.push(DiscoveredSkill {
            id,
            title: name,
            description,
            lane: DiscoveryLane::Registry.as_str().to_string(),
            provenance: "playbooks-api".to_string(),
            is_installable: install_source.is_some(),
            source: "playbooks".to_string(),
            source_label: "Playbooks".to_string(),
            install_source,
            suggested_name: skill_slug,
            homepage,
            repo,
            language: record
                .primary_language
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string()),
            tags: record
                .tags
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect(),
            is_official: record.is_official,
            stars: record.stars,
            category: None,
            risk: record.safety_risk_level,
            health_grade: record.health_grade,
            health_score: record.health_score,
        });
    }

    verify_playbooks_install_sources(state, &mut out, limit).await;
    Ok(out)
}

fn build_playbooks_install_source(
    repo_owner: Option<&str>,
    repo_name: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    let owner = repo_owner?.trim();
    let repo = repo_name?.trim();
    let raw_path = path?.trim().trim_matches('/');
    if owner.is_empty() || repo.is_empty() || raw_path.is_empty() {
        return None;
    }
    Some(format!(
        "https://github.com/{owner}/{repo}/blob/HEAD/{raw_path}"
    ))
}

fn build_playbooks_homepage(
    repo_owner: Option<&str>,
    repo_name: Option<&str>,
    skill_slug: Option<&str>,
) -> Option<String> {
    let owner = repo_owner?.trim();
    let repo = repo_name?.trim();
    let slug = skill_slug?.trim();
    if owner.is_empty() || repo.is_empty() || slug.is_empty() {
        return None;
    }
    Some(format!(
        "https://playbooks.com/skills/{owner}/{repo}/{slug}"
    ))
}

async fn verify_playbooks_install_sources(
    state: &AppState,
    items: &mut [DiscoveredSkill],
    limit: usize,
) {
    let verify_limit = items
        .len()
        .min(limit.max(1))
        .min(PLAYBOOKS_INSTALL_VALIDATION_LIMIT);
    if verify_limit == 0 {
        return;
    }

    for item in items.iter_mut().take(verify_limit) {
        if !item.is_installable {
            continue;
        }
        if !item.source.eq_ignore_ascii_case("playbooks") {
            continue;
        }
        let Some(install_source) = item
            .install_source
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            item.is_installable = false;
            item.install_source = None;
            continue;
        };

        match verify_install_source_with_cache(state, install_source).await {
            Some(resolved_source) => {
                item.install_source = Some(resolved_source);
                item.is_installable = true;
            }
            None => {
                item.install_source = None;
                item.is_installable = false;
            }
        }
    }
}

async fn verify_install_source_with_cache(state: &AppState, source: &str) -> Option<String> {
    let normalized = source.trim();
    if normalized.is_empty() {
        return None;
    }

    if let Some(cached) = read_install_source_cache(normalized).await {
        return cached;
    }

    let resolved = verify_install_source_uncached(state, normalized).await;
    write_install_source_cache(normalized.to_string(), resolved.clone()).await;
    resolved
}

async fn read_install_source_cache(cache_key: &str) -> Option<Option<String>> {
    let now = Instant::now();
    {
        let cache = INSTALL_SOURCE_CACHE.read().await;
        if let Some(entry) = cache.get(cache_key) {
            if entry.expires_at > now {
                return Some(entry.resolved_source.clone());
            }
        }
    }

    let mut cache = INSTALL_SOURCE_CACHE.write().await;
    cache.retain(|_, entry| entry.expires_at > now);
    cache
        .get(cache_key)
        .map(|entry| entry.resolved_source.clone())
}

async fn write_install_source_cache(cache_key: String, resolved_source: Option<String>) {
    let mut cache = INSTALL_SOURCE_CACHE.write().await;
    let now = Instant::now();
    cache.retain(|_, entry| entry.expires_at > now);
    cache.insert(
        cache_key,
        CachedInstallSourceEntry {
            expires_at: now + INSTALL_SOURCE_CACHE_TTL,
            resolved_source,
        },
    );
}

async fn verify_install_source_uncached(state: &AppState, source: &str) -> Option<String> {
    let Some(github_source) = parse_github_install_source(source) else {
        return Some(source.to_string());
    };
    let candidate_paths = build_install_source_candidate_paths(&github_source.skill_file_path);
    if candidate_paths.is_empty() {
        return None;
    }

    let mut saw_unknown = false;
    for candidate_path in candidate_paths {
        let raw_url = build_github_raw_url(
            github_source.owner.as_str(),
            github_source.repo.as_str(),
            github_source.branch.as_str(),
            candidate_path.as_str(),
        );
        match probe_remote_file_status(state, raw_url.as_str()).await {
            RemoteFileStatus::Exists => {
                return Some(build_github_blob_url(
                    github_source.owner.as_str(),
                    github_source.repo.as_str(),
                    github_source.branch.as_str(),
                    candidate_path.as_str(),
                ));
            }
            RemoteFileStatus::Missing => {}
            RemoteFileStatus::Unknown => {
                saw_unknown = true;
            }
        }
    }

    if saw_unknown {
        Some(source.to_string())
    } else {
        None
    }
}

fn build_install_source_candidate_paths(skill_file_path: &str) -> Vec<String> {
    let normalized = skill_file_path.trim().trim_matches('/').to_string();
    if normalized.is_empty() {
        return Vec::new();
    }

    let lower_path = normalized.to_ascii_lowercase();
    let mut candidate_paths = vec![normalized.clone()];
    if !lower_path.starts_with("skills/") {
        candidate_paths.push(format!("skills/{normalized}"));
    }
    if !lower_path.starts_with("composio-skills/") {
        candidate_paths.push(format!("composio-skills/{normalized}"));
    }

    candidate_paths.sort_unstable();
    candidate_paths.dedup();
    candidate_paths
}

fn parse_github_install_source(source: &str) -> Option<GitHubInstallSource> {
    let parsed = Url::parse(source).ok()?;
    let host = parsed.host_str()?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }

    let segments = parsed
        .path_segments()
        .map(|value| value.map(str::trim).collect::<Vec<&str>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_string())
        .collect::<Vec<String>>();
    if segments.len() < 5 {
        return None;
    }

    let mode = segments[2].to_ascii_lowercase();
    if mode != "blob" && mode != "tree" {
        return None;
    }

    let owner = segments[0].trim().to_string();
    let repo = segments[1].trim().to_string();
    let branch = segments[3].trim().to_string();
    if owner.is_empty() || repo.is_empty() || branch.is_empty() {
        return None;
    }

    let remainder = segments[4..]
        .iter()
        .map(String::as_str)
        .collect::<Vec<&str>>()
        .join("/");
    if remainder.trim().is_empty() {
        return None;
    }

    let skill_file_path = if remainder
        .to_ascii_lowercase()
        .ends_with(SKILL_FILENAME.to_ascii_lowercase().as_str())
    {
        remainder
    } else {
        format!("{}/{}", remainder.trim_matches('/'), SKILL_FILENAME)
    };
    let normalized_skill_path = skill_file_path.trim_matches('/').to_string();
    if normalized_skill_path.is_empty() {
        return None;
    }

    Some(GitHubInstallSource {
        owner,
        repo,
        branch,
        skill_file_path: normalized_skill_path,
    })
}

fn build_github_raw_url(owner: &str, repo: &str, branch: &str, path: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{owner}/{repo}/{}/{}",
        urlencoding::encode(branch),
        path.trim_start_matches('/')
    )
}

async fn probe_remote_file_status(state: &AppState, url: &str) -> RemoteFileStatus {
    let request = state
        .http_client
        .get(url)
        .header("accept", "text/plain")
        .header("user-agent", GITHUB_USER_AGENT);
    let response = match timeout(INSTALL_SOURCE_HTTP_TIMEOUT, request.send()).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            tracing::warn!(url = %url, error = %error, "install source probe request failed");
            return RemoteFileStatus::Unknown;
        }
        Err(_) => {
            tracing::warn!(url = %url, "install source probe timed out");
            return RemoteFileStatus::Unknown;
        }
    };

    if response.status().is_success() {
        return RemoteFileStatus::Exists;
    }
    if response.status().as_u16() == 404 {
        return RemoteFileStatus::Missing;
    }
    tracing::warn!(
        url = %url,
        status = %response.status(),
        "install source probe returned non-success status"
    );
    RemoteFileStatus::Unknown
}

async fn fetch_github_catalog_results(
    state: &AppState,
    user_id: Option<&Uuid>,
    query: &str,
    limit: usize,
) -> Result<Vec<DiscoveredSkill>, String> {
    let curated_catalog_task = load_curated_github_catalogs(state, user_id);
    let code_search_task = fetch_github_code_search_results(state, query, limit);
    let repo_shim_task = fetch_github_repo_shim_results(state, query, limit);

    let (curated_catalog_result, code_search_result, repo_shim_result) =
        tokio::join!(curated_catalog_task, code_search_task, repo_shim_task);

    let mut merged = Vec::new();
    let mut errors = Vec::new();

    match curated_catalog_result {
        (catalog_entries, catalog_errors) => {
            if !catalog_entries.is_empty() {
                merged.extend(rank_curated_catalog_matches(catalog_entries, query, limit));
            }
            errors.extend(catalog_errors);
        }
    }
    match code_search_result {
        Ok(items) => merged.extend(items),
        Err(error) => errors.push(format!("GitHub code search failed: {error}")),
    }
    match repo_shim_result {
        Ok(items) => merged.extend(items),
        Err(error) => errors.push(format!("GitHub repo shim failed: {error}")),
    }

    if merged.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }

    Ok(merged)
}

fn rank_curated_catalog_matches(
    catalog: Vec<CuratedCatalogEntry>,
    query: &str,
    limit: usize,
) -> Vec<DiscoveredSkill> {
    let terms = parse_query_terms(query);
    let mut scored = catalog
        .into_iter()
        .filter_map(|entry| {
            let haystack = format!(
                "{} {} {} {}",
                entry.title,
                entry.slug,
                entry.description,
                entry.category.as_deref().unwrap_or("")
            )
            .to_ascii_lowercase();
            if !query_terms_match(haystack.as_str(), &terms) {
                return None;
            }
            Some((score_curated_entry(&entry, &terms), entry))
        })
        .collect::<Vec<(i64, CuratedCatalogEntry)>>();

    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.slug.cmp(&right.1.slug))
    });

    let mut out = Vec::new();
    for (_, entry) in scored.into_iter().take(limit) {
        out.push(DiscoveredSkill {
            id: format!(
                "github:curated:{}:{}",
                entry.repo_full_name.replace('/', ":"),
                entry.slug
            ),
            title: entry.title,
            description: truncate_text(entry.description.as_str(), 200),
            lane: DiscoveryLane::Curated.as_str().to_string(),
            provenance: entry.provenance,
            is_installable: true,
            source: "github".to_string(),
            source_label: "GitHub".to_string(),
            install_source: Some(entry.source.clone()),
            suggested_name: Some(entry.slug),
            homepage: Some(entry.source),
            repo: Some(entry.repo_full_name),
            language: None,
            tags: Vec::new(),
            is_official: None,
            stars: entry.stars,
            category: entry.category,
            risk: None,
            health_grade: None,
            health_score: None,
        });
    }

    out
}

async fn fetch_github_code_search_results(
    state: &AppState,
    query: &str,
    limit: usize,
) -> Result<Vec<DiscoveredSkill>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let per_page = (limit * 2).clamp(1, MAX_RESULT_LIMIT);
    let mut url = Url::parse(GITHUB_CODE_SEARCH_API_URL)
        .map_err(|error| format!("invalid GitHub code search URL: {error}"))?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("q", format!("{query} filename:{SKILL_FILENAME}").as_str());
        query_pairs.append_pair("per_page", per_page.to_string().as_str());
    }

    let payload: GitHubCodeSearchResponse = fetch_json_from_url(state, url).await?;
    let mut out = Vec::new();

    for item in payload.items {
        let path = item.path.trim();
        let path_lower = path.to_ascii_lowercase();
        let is_skill_path =
            path_lower.eq_ignore_ascii_case("skill.md") || path_lower.ends_with("/skill.md");
        if path.is_empty() || !is_skill_path {
            continue;
        }

        let Some(repo_full_name) = github_repo_full_name(&item.repository) else {
            continue;
        };
        let Some((owner, repo_name)) = split_github_owner_repo(repo_full_name.as_str()) else {
            continue;
        };
        let branch = item
            .repository
            .default_branch
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("HEAD");
        let install_source = item
            .html_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| Some(build_github_blob_url(owner, repo_name, branch, path)));

        let fallback_slug = normalize_skill_name(path).unwrap_or_else(|| "skill".to_string());
        let slug = derive_skill_slug_from_path(path, Some(repo_name))
            .or_else(|| normalize_skill_name(repo_name))
            .unwrap_or(fallback_slug);
        let title = humanize_slug(slug.as_str());
        let description = item
            .repository
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| truncate_text(value, 200))
            .unwrap_or_else(|| {
                truncate_text(
                    format!("Skill file at `{path}` in `{repo_full_name}`.").as_str(),
                    200,
                )
            });

        out.push(DiscoveredSkill {
            id: format!("github:code-search:{repo_full_name}:{path}"),
            title,
            description,
            lane: DiscoveryLane::LongTail.as_str().to_string(),
            provenance: "github-code-search".to_string(),
            is_installable: install_source.is_some(),
            source: "github".to_string(),
            source_label: "GitHub".to_string(),
            install_source,
            suggested_name: Some(slug),
            homepage: item
                .repository
                .html_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .or_else(|| Some(format!("https://github.com/{repo_full_name}"))),
            repo: Some(repo_full_name),
            language: None,
            tags: vec!["code-search".to_string()],
            is_official: None,
            stars: item.repository.stargazers_count,
            category: Some("GitHub code search".to_string()),
            risk: None,
            health_grade: None,
            health_score: None,
        });
    }

    Ok(out)
}

async fn fetch_github_repo_shim_results(
    state: &AppState,
    query: &str,
    limit: usize,
) -> Result<Vec<DiscoveredSkill>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let search_limit = limit.clamp(1, MAX_GITHUB_REPO_SHIM_REPOS);
    let mut url = Url::parse(GITHUB_REPO_SEARCH_API_URL)
        .map_err(|error| format!("invalid GitHub repo search URL: {error}"))?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair(
            "q",
            format!("{query} skill in:name,description,readme").as_str(),
        );
        query_pairs.append_pair("per_page", search_limit.to_string().as_str());
    }

    let payload: GitHubRepositorySearchResponse = fetch_json_from_url(state, url).await?;
    if payload.items.is_empty() {
        return Ok(Vec::new());
    }

    let terms = parse_query_terms(query);
    let mut out = Vec::new();

    for repo in payload.items.into_iter().take(search_limit) {
        let Some(full_name) = github_repo_full_name(&repo) else {
            continue;
        };
        let Some((owner, repo_name)) = split_github_owner_repo(full_name.as_str()) else {
            continue;
        };

        let branch = repo
            .default_branch
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("main");
        let skill_paths = fetch_github_repo_skill_paths(
            state,
            owner,
            repo_name,
            branch,
            &terms,
            MAX_GITHUB_REPO_SHIM_SKILLS_PER_REPO,
        )
        .await?;

        for path in skill_paths {
            let slug = derive_skill_slug_from_path(path.as_str(), Some(repo_name))
                .or_else(|| normalize_skill_name(repo_name))
                .unwrap_or_else(|| "skill".to_string());
            let description = repo
                .description
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    truncate_text(
                        format!("{value} (resolved skill path: `{path}`)").as_str(),
                        200,
                    )
                })
                .unwrap_or_else(|| {
                    truncate_text(
                        format!("Repository result shim resolved `{path}` as an installable skill path.").as_str(),
                        200,
                    )
                });

            out.push(DiscoveredSkill {
                id: format!("github:repo-shim:{full_name}:{path}"),
                title: humanize_slug(slug.as_str()),
                description,
                lane: DiscoveryLane::LongTail.as_str().to_string(),
                provenance: "github-repo-shim".to_string(),
                is_installable: true,
                source: "github".to_string(),
                source_label: "GitHub".to_string(),
                install_source: Some(build_github_blob_url(
                    owner,
                    repo_name,
                    branch,
                    path.as_str(),
                )),
                suggested_name: Some(slug),
                homepage: repo
                    .html_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string())
                    .or_else(|| Some(format!("https://github.com/{full_name}"))),
                repo: Some(full_name.clone()),
                language: None,
                tags: vec!["repo-shim".to_string()],
                is_official: None,
                stars: repo.stargazers_count,
                category: Some("GitHub repository shim".to_string()),
                risk: None,
                health_grade: None,
                health_score: None,
            });
        }
    }

    Ok(out)
}

async fn fetch_github_repo_skill_paths(
    state: &AppState,
    owner: &str,
    repo: &str,
    branch: &str,
    terms: &[String],
    max_items: usize,
) -> Result<Vec<String>, String> {
    let mut url = Url::parse(
        format!(
            "https://api.github.com/repos/{owner}/{repo}/git/trees/{}",
            urlencoding::encode(branch)
        )
        .as_str(),
    )
    .map_err(|error| format!("invalid GitHub tree URL for {owner}/{repo}: {error}"))?;
    url.query_pairs_mut().append_pair("recursive", "1");

    let payload: GitHubTreeResponse = fetch_json_from_url(state, url).await?;
    if payload.tree.is_empty() {
        return Ok(Vec::new());
    }
    if payload.truncated {
        tracing::warn!(
            repo = format!("{owner}/{repo}"),
            "GitHub tree API response was truncated; skill shim may miss entries"
        );
    }

    let mut candidates = payload
        .tree
        .into_iter()
        .take(MAX_GITHUB_TREE_SCAN_ENTRIES)
        .filter_map(|entry| {
            if !entry.entry_type.eq_ignore_ascii_case("blob") {
                return None;
            }
            let path = entry.path.trim();
            let path_lower = path.to_ascii_lowercase();
            let is_skill_path =
                path_lower.eq_ignore_ascii_case("skill.md") || path_lower.ends_with("/skill.md");
            if path.is_empty() || !is_skill_path {
                return None;
            }
            Some((score_github_skill_path(path, terms), path.to_string()))
        })
        .collect::<Vec<(i64, String)>>();

    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let out = candidates
        .into_iter()
        .take(max_items)
        .map(|(_, path)| path)
        .collect::<Vec<String>>();
    Ok(out)
}

fn score_github_skill_path(path: &str, terms: &[String]) -> i64 {
    let lower_path = path.to_ascii_lowercase();
    let mut score = 0_i64;
    if lower_path.contains("/skills/") {
        score += 10;
    }
    if lower_path.starts_with("skills/") {
        score += 6;
    }
    if lower_path.contains(".agents/skills/") {
        score += 4;
    }
    if lower_path.contains("/examples/") || lower_path.contains("/test/") {
        score -= 3;
    }
    for term in terms {
        if lower_path.contains(term) {
            score += 5;
        }
    }
    score
}

fn derive_skill_slug_from_path(path: &str, repo_name: Option<&str>) -> Option<String> {
    let segments = path
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<&str>>();
    if segments.is_empty() {
        return repo_name.and_then(normalize_skill_name);
    }

    if segments
        .last()
        .map(|value| value.eq_ignore_ascii_case(SKILL_FILENAME))
        .unwrap_or(false)
    {
        if segments.len() >= 2 {
            return normalize_skill_name(segments[segments.len() - 2]);
        }
    }

    segments
        .last()
        .and_then(|value| normalize_skill_name(value))
        .or_else(|| repo_name.and_then(normalize_skill_name))
}

fn github_repo_full_name(repo: &GitHubRepositoryRecord) -> Option<String> {
    if !repo.full_name.trim().is_empty() {
        return Some(repo.full_name.trim().to_string());
    }
    let owner = repo.owner.as_ref()?.login.trim();
    let name = repo.name.trim();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

fn split_github_owner_repo(full_name: &str) -> Option<(&str, &str)> {
    let mut parts = full_name
        .trim()
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

fn build_github_blob_url(owner: &str, repo: &str, branch: &str, path: &str) -> String {
    format!(
        "https://github.com/{owner}/{repo}/blob/{}/{}",
        urlencoding::encode(branch),
        path.trim_start_matches('/')
    )
}

async fn fetch_json_from_url<T: DeserializeOwned>(state: &AppState, url: Url) -> Result<T, String> {
    let request = state
        .http_client
        .get(url.clone())
        .header("accept", "application/vnd.github+json")
        .header("user-agent", GITHUB_USER_AGENT);
    let response = timeout(DISCOVERY_HTTP_TIMEOUT, request.send())
        .await
        .map_err(|_| format!("request timed out: {url}"))?
        .map_err(|error| format!("request failed for {url}: {error}"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("request failed with HTTP {status}: {url}"));
        }
        return Err(format!("request failed with HTTP {status}: {detail}"));
    }

    response
        .json::<T>()
        .await
        .map_err(|error| format!("response decoding failed for {url}: {error}"))
}

async fn load_curated_github_catalogs(
    state: &AppState,
    user_id: Option<&Uuid>,
) -> (Vec<CuratedCatalogEntry>, Vec<String>) {
    let openclaw_task = load_openclaw_catalog(state, user_id);
    let composio_task = load_composio_catalog(state, user_id);
    let (openclaw_result, composio_result) = tokio::join!(openclaw_task, composio_task);

    let mut entries = Vec::new();
    let mut errors = Vec::new();
    match openclaw_result {
        Ok(mut catalog) => entries.append(&mut catalog),
        Err(error) => errors.push(format!("OpenClaw catalog failed: {error}")),
    }
    match composio_result {
        Ok(mut catalog) => entries.append(&mut catalog),
        Err(error) => errors.push(format!("Composio catalog failed: {error}")),
    }

    (entries, errors)
}

async fn load_openclaw_catalog(
    state: &AppState,
    user_id: Option<&Uuid>,
) -> Result<Vec<CuratedCatalogEntry>, String> {
    let now = Instant::now();
    {
        let cache_guard = OPENCLAW_CATALOG_CACHE.read().await;
        if let Some(cache) = cache_guard.as_ref() {
            if cache.expires_at > now {
                return Ok(cache.entries.clone());
            }
        }
    }

    let request = state
        .http_client
        .get(OPENCLAW_AWESOME_README_URL)
        .header("accept", "text/plain");
    let response = timeout(DISCOVERY_HTTP_TIMEOUT, request.send())
        .await
        .map_err(|_| "GitHub source request timed out".to_string())?
        .map_err(|error| format!("GitHub source request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("GitHub source returned HTTP {status}"));
        }
        return Err(format!("GitHub source returned HTTP {status}: {detail}"));
    }

    let markdown = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub source response: {error}"))?;
    let mut parsed = parse_openclaw_catalog(markdown.as_str());
    let stars = fetch_github_repo_stars(state, OPENCLAW_REPO_OWNER, OPENCLAW_REPO_NAME)
        .await
        .ok()
        .flatten();
    for entry in &mut parsed {
        entry.stars = stars;
    }
    if parsed.is_empty() {
        if let Some(user_id) = user_id {
            tracing::warn!(
                user_id = %user_id,
                "openclaw catalog parsed with no entries"
            );
        } else {
            tracing::warn!("openclaw catalog parsed with no entries");
        }
    }

    let mut cache_guard = OPENCLAW_CATALOG_CACHE.write().await;
    *cache_guard = Some(CachedOpenClawCatalog {
        expires_at: Instant::now() + OPENCLAW_CACHE_TTL,
        entries: parsed.clone(),
    });

    Ok(parsed)
}

fn parse_openclaw_catalog(markdown: &str) -> Vec<CuratedCatalogEntry> {
    let mut entries = Vec::new();
    let mut seen_sources = HashSet::new();
    let mut current_category: Option<String> = None;

    for raw_line in markdown.replace("\r\n", "\n").split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(category) = parse_summary_heading(line) {
            current_category = Some(category);
            continue;
        }

        let Some(rest) = line.strip_prefix("- [") else {
            continue;
        };
        let Some(label_end) = rest.find("](") else {
            continue;
        };
        let title_raw = rest[..label_end].trim();
        let after_label = &rest[label_end + 2..];
        let Some(url_end) = after_label.find(')') else {
            continue;
        };
        let source = after_label[..url_end].trim();
        if source.is_empty()
            || !source.starts_with(OPENCLAW_SKILLS_URL_PREFIX)
            || !source.to_ascii_lowercase().ends_with("/skill.md")
        {
            continue;
        }
        if !seen_sources.insert(source.to_string()) {
            continue;
        }

        let after_url = after_label[url_end + 1..].trim();
        let description = after_url
            .strip_prefix('-')
            .map(str::trim)
            .unwrap_or(after_url);
        if description.is_empty() {
            continue;
        }

        let slug = source
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<&str>>()
            .windows(2)
            .find_map(|window| {
                let left = *window.first()?;
                let right = *window.get(1)?;
                if right.eq_ignore_ascii_case("SKILL.md") {
                    normalize_skill_name(left)
                } else {
                    None
                }
            });
        let Some(slug) = slug else {
            continue;
        };

        let title = if title_raw.is_empty() {
            humanize_slug(slug.as_str())
        } else {
            decode_minimal_html_entities(title_raw)
        };

        entries.push(CuratedCatalogEntry {
            title,
            slug,
            description: decode_minimal_html_entities(description),
            category: current_category.clone(),
            repo_full_name: OPENCLAW_REPO_FULL_NAME.to_string(),
            provenance: "openclaw-awesome".to_string(),
            source: source.to_string(),
            stars: None,
        });
    }

    entries
}

async fn load_composio_catalog(
    state: &AppState,
    user_id: Option<&Uuid>,
) -> Result<Vec<CuratedCatalogEntry>, String> {
    let now = Instant::now();
    {
        let cache_guard = COMPOSIO_CATALOG_CACHE.read().await;
        if let Some(cache) = cache_guard.as_ref() {
            if cache.expires_at > now {
                return Ok(cache.entries.clone());
            }
        }
    }

    let tree_url = Url::parse(COMPOSIO_TREE_API_URL)
        .map_err(|error| format!("invalid Composio tree URL: {error}"))?;
    let tree_payload: GitHubTreeResponse = fetch_json_from_url(state, tree_url).await?;
    let stars = fetch_github_repo_stars(state, COMPOSIO_REPO_OWNER, COMPOSIO_REPO_NAME)
        .await
        .ok()
        .flatten();

    let mut entries = Vec::new();
    let mut seen_sources = HashSet::new();
    for tree_entry in tree_payload.tree.iter().take(MAX_GITHUB_TREE_SCAN_ENTRIES) {
        if !tree_entry.entry_type.eq_ignore_ascii_case("blob") {
            continue;
        }
        let path = tree_entry.path.trim();
        let path_lower = path.to_ascii_lowercase();
        let is_skill_path =
            path_lower.eq_ignore_ascii_case("skill.md") || path_lower.ends_with("/skill.md");
        if path.is_empty() || !is_skill_path {
            continue;
        }
        let source = build_github_blob_url(
            COMPOSIO_REPO_OWNER,
            COMPOSIO_REPO_NAME,
            COMPOSIO_REPO_BRANCH,
            path,
        );
        if !seen_sources.insert(source.clone()) {
            continue;
        }

        let slug = derive_skill_slug_from_path(path, Some(COMPOSIO_REPO_NAME))
            .or_else(|| normalize_skill_name(path))
            .unwrap_or_else(|| "skill".to_string());
        let title = humanize_slug(slug.as_str());
        let category = Some(parse_composio_category(path));
        let description = truncate_text(
            format!("Curated skill from {COMPOSIO_REPO_FULL_NAME} (path: `{path}`).").as_str(),
            200,
        );

        entries.push(CuratedCatalogEntry {
            title,
            slug,
            description,
            category,
            repo_full_name: COMPOSIO_REPO_FULL_NAME.to_string(),
            provenance: "composio-awesome-repo".to_string(),
            source,
            stars,
        });
    }

    if entries.is_empty() {
        if let Some(user_id) = user_id {
            tracing::warn!(
                user_id = %user_id,
                "composio catalog parsed with no entries"
            );
        } else {
            tracing::warn!("composio catalog parsed with no entries");
        }
    }

    let mut cache_guard = COMPOSIO_CATALOG_CACHE.write().await;
    *cache_guard = Some(CachedComposioCatalog {
        expires_at: Instant::now() + OPENCLAW_CACHE_TTL,
        entries: entries.clone(),
    });

    Ok(entries)
}

fn parse_composio_category(path: &str) -> String {
    let normalized = path.trim().trim_matches('/');
    if normalized.is_empty() {
        return "Composio curated".to_string();
    }
    let mut segments = normalized
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty());
    let Some(first) = segments.next() else {
        return "Composio curated".to_string();
    };
    if first.eq_ignore_ascii_case("composio-skills") {
        return "Composio automations".to_string();
    }
    if first.eq_ignore_ascii_case("skills") {
        return "Composio skills".to_string();
    }
    format!("Composio · {}", humanize_slug(first))
}

async fn fetch_github_repo_stars(
    state: &AppState,
    owner: &str,
    repo: &str,
) -> Result<Option<u64>, String> {
    let repo_url = Url::parse(format!("https://api.github.com/repos/{owner}/{repo}").as_str())
        .map_err(|error| format!("invalid GitHub repo URL for {owner}/{repo}: {error}"))?;
    let payload: GitHubRepositoryRecord = fetch_json_from_url(state, repo_url).await?;
    Ok(payload.stargazers_count)
}

fn parse_summary_heading(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let summary_start = lower.find("<summary")?;
    let summary_open_end = summary_start + lower[summary_start..].find('>')?;
    let content_start = summary_open_end + 1;
    let content_end = if let Some(relative_end) = lower[content_start..].find("</summary>") {
        content_start + relative_end
    } else {
        line.len()
    };
    let text = line[content_start..content_end].trim();
    let decoded = decode_minimal_html_entities(text);
    let plain = strip_html_tags(decoded.as_str())
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    if plain.is_empty() {
        return None;
    }
    Some(plain)
}

fn decode_minimal_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn strip_html_tags(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut inside_tag = false;
    for ch in value.chars() {
        if ch == '<' {
            inside_tag = true;
            continue;
        }
        if ch == '>' {
            inside_tag = false;
            continue;
        }
        if !inside_tag {
            output.push(ch);
        }
    }
    output
}

fn parse_query_terms(query: &str) -> Vec<String> {
    let mut terms = query
        .to_ascii_lowercase()
        .split_whitespace()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(8)
        .map(|value| value.to_string())
        .collect::<Vec<String>>();

    if terms.is_empty() {
        let compact = query.trim().to_ascii_lowercase();
        if !compact.is_empty() {
            terms.push(compact);
        }
    }
    terms
}

fn query_terms_match(haystack: &str, terms: &[String]) -> bool {
    if terms.is_empty() {
        return true;
    }
    terms.iter().all(|term| haystack.contains(term))
}

fn score_curated_entry(entry: &CuratedCatalogEntry, terms: &[String]) -> i64 {
    let title = entry.title.to_ascii_lowercase();
    let slug = entry.slug.to_ascii_lowercase();
    let description = entry.description.to_ascii_lowercase();
    let category = entry.category.as_deref().unwrap_or("").to_ascii_lowercase();

    let mut score = 0_i64;
    for term in terms {
        if title.contains(term) {
            score += 12;
        }
        if slug.contains(term) {
            score += 10;
        }
        if description.contains(term) {
            score += 6;
        }
        if category.contains(term) {
            score += 4;
        }
    }

    if terms.is_empty() {
        let category_priority = OPENCLAW_PRIORITY_CATEGORIES
            .iter()
            .position(|value| value.eq_ignore_ascii_case(category.as_str()))
            .map(|index| (OPENCLAW_PRIORITY_CATEGORIES.len().saturating_sub(index)) as i64)
            .unwrap_or(0);
        score += category_priority * 8;

        let blob = format!("{slug} {description}");
        for keyword in OPENCLAW_POSITIVE_KEYWORDS {
            if blob.contains(keyword) {
                score += 4;
            }
        }
        for keyword in OPENCLAW_NEGATIVE_KEYWORDS {
            if blob.contains(keyword) {
                score -= 6;
            }
        }
        score += (description.len() as i64 / 50).min(4);
    }

    score
}

fn dedupe_and_rank(
    mut items: Vec<DiscoveredSkill>,
    query: &str,
    limit: usize,
) -> Vec<DiscoveredSkill> {
    let terms = parse_query_terms(query);
    items.sort_by(|left, right| {
        score_discovery_result(right, &terms)
            .cmp(&score_discovery_result(left, &terms))
            .then_with(|| right.stars.unwrap_or(0).cmp(&left.stars.unwrap_or(0)))
            .then_with(|| left.title.cmp(&right.title))
    });

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let dedupe_key = item
            .install_source
            .as_deref()
            .unwrap_or(item.id.as_str())
            .trim()
            .to_ascii_lowercase();
        if dedupe_key.is_empty() || !seen.insert(dedupe_key) {
            continue;
        }
        out.push(item);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn compute_lane_counts(results: &[DiscoveredSkill]) -> DiscoveryLaneCounts {
    let mut counts = DiscoveryLaneCounts::default();
    for item in results {
        match item.lane.as_str() {
            "curated" => counts.curated += 1,
            "registry" => counts.registry += 1,
            "long_tail" => counts.long_tail += 1,
            _ => {}
        }
    }
    counts
}

fn compute_curated_category_counts(
    catalog: &[CuratedCatalogEntry],
    query: &str,
) -> Vec<DiscoveryCategoryCount> {
    if catalog.is_empty() {
        return Vec::new();
    }
    let terms = parse_query_terms(query);
    let mut grouped = HashMap::<String, usize>::new();

    for entry in catalog {
        let category = entry
            .category
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Other")
            .to_string();

        if !terms.is_empty() {
            let haystack = format!(
                "{} {} {} {}",
                entry.title,
                entry.slug,
                entry.description,
                entry.category.as_deref().unwrap_or("")
            )
            .to_ascii_lowercase();
            if !query_terms_match(haystack.as_str(), &terms) {
                continue;
            }
        }

        let entry_count = grouped.entry(category).or_insert(0);
        *entry_count += 1;
    }

    let mut out = grouped
        .into_iter()
        .map(|(name, count)| DiscoveryCategoryCount { name, count })
        .collect::<Vec<DiscoveryCategoryCount>>();
    out.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    out
}

fn score_discovery_result(item: &DiscoveredSkill, terms: &[String]) -> i64 {
    let title = item.title.to_ascii_lowercase();
    let description = item.description.to_ascii_lowercase();
    let tags = item.tags.join(" ").to_ascii_lowercase();

    let mut score = 0_i64;
    for term in terms {
        if title.contains(term) {
            score += 14;
        }
        if description.contains(term) {
            score += 7;
        }
        if tags.contains(term) {
            score += 4;
        }
    }

    if item.is_official == Some(true) {
        score += 8;
    }
    if let Some(stars) = item.stars {
        score += match stars {
            100_000.. => 8,
            10_000..=99_999 => 6,
            1_000..=9_999 => 4,
            100..=999 => 2,
            _ => 1,
        };
    }

    score += match item.lane.as_str() {
        "curated" => 12,
        "registry" => 8,
        "long_tail" => 3,
        _ => 1,
    };

    if item.is_installable {
        score += 10;
    } else {
        score -= 6;
    }

    score
}

fn normalize_skill_name(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<&str>>()
        .join("-");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn humanize_slug(slug: &str) -> String {
    let normalized = slug
        .trim()
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    if normalized.is_empty() {
        return "Unnamed skill".to_string();
    }
    normalized
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            let first = chars.next().unwrap_or_default().to_ascii_uppercase();
            let rest = chars.as_str().to_ascii_lowercase();
            format!("{first}{rest}")
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn truncate_text(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }
    let mut out = String::new();
    for ch in trimmed.chars().take(max_len.saturating_sub(1)) {
        out.push(ch);
    }
    let clipped = out.trim_end().to_string();
    format!("{clipped}…")
}

#[cfg(test)]
mod tests {
    use super::{
        build_github_raw_url, build_install_source_candidate_paths, parse_github_install_source,
        parse_sources, parse_summary_heading, strip_html_tags, DiscoverySource,
    };

    #[test]
    fn parse_summary_heading_handles_inline_style_h3() {
        let line = r#"<summary><h3 style="display:inline">Communication</h3></summary>"#;
        let parsed = parse_summary_heading(line);
        assert_eq!(parsed.as_deref(), Some("Communication"));
    }

    #[test]
    fn parse_summary_heading_handles_plain_summary_text() {
        let line = r#"<summary>Speech &amp; Transcription</summary>"#;
        let parsed = parse_summary_heading(line);
        assert_eq!(parsed.as_deref(), Some("Speech & Transcription"));
    }

    #[test]
    fn parse_summary_heading_handles_encoded_nested_markup() {
        let line =
            r#"<summary>&lt;h3 style="display:inline"&gt;Notes &amp; PKM&lt;/h3&gt;</summary>"#;
        let parsed = parse_summary_heading(line);
        assert_eq!(parsed.as_deref(), Some("Notes & PKM"));
    }

    #[test]
    fn strip_html_tags_removes_wrapped_markup() {
        let value = r#"<h3 style="display:inline">Speech &amp; Transcription</h3>"#;
        let stripped = strip_html_tags(value);
        assert_eq!(stripped, "Speech &amp; Transcription");
    }

    #[test]
    fn parse_github_install_source_blob_keeps_skill_path() {
        let parsed = parse_github_install_source(
            "https://github.com/openclaw/skills/blob/HEAD/skills/0xs4m1337/openclaw-whatsapp/SKILL.md",
        )
        .expect("expected github install source");
        assert_eq!(parsed.owner, "openclaw");
        assert_eq!(parsed.repo, "skills");
        assert_eq!(parsed.branch, "HEAD");
        assert_eq!(
            parsed.skill_file_path,
            "skills/0xs4m1337/openclaw-whatsapp/SKILL.md"
        );
    }

    #[test]
    fn parse_github_install_source_tree_appends_skill_file() {
        let parsed = parse_github_install_source(
            "https://github.com/openclaw/skills/tree/main/skills/0xs4m1337/openclaw-whatsapp",
        )
        .expect("expected github tree install source");
        assert_eq!(
            parsed.skill_file_path,
            "skills/0xs4m1337/openclaw-whatsapp/SKILL.md"
        );
    }

    #[test]
    fn build_install_source_candidate_paths_adds_fallback_prefixes() {
        let candidates = build_install_source_candidate_paths("whatsapp-automation/SKILL.md");
        assert_eq!(
            candidates,
            vec![
                "composio-skills/whatsapp-automation/SKILL.md".to_string(),
                "skills/whatsapp-automation/SKILL.md".to_string(),
                "whatsapp-automation/SKILL.md".to_string(),
            ]
        );
    }

    #[test]
    fn build_github_raw_url_uses_branch_and_path() {
        let url = build_github_raw_url(
            "openclaw",
            "skills",
            "main",
            "skills/0xs4m1337/openclaw-whatsapp/SKILL.md",
        );
        assert_eq!(
            url,
            "https://raw.githubusercontent.com/openclaw/skills/main/skills/0xs4m1337/openclaw-whatsapp/SKILL.md"
        );
    }

    #[test]
    fn parse_sources_defaults_to_github_when_playbooks_disabled() {
        let sources = parse_sources(None, false);
        assert_eq!(sources, vec![DiscoverySource::Github]);
    }

    #[test]
    fn parse_sources_all_includes_playbooks_when_enabled() {
        let sources = parse_sources(Some("all"), true);
        assert_eq!(
            sources,
            vec![DiscoverySource::Playbooks, DiscoverySource::Github]
        );
    }
}
