use std::collections::BTreeMap;
use std::str::FromStr;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ota::require_operator_access;
use crate::{bad_request, internal_error, ApiError, AppState};

const DEFAULT_EDGE_DOWNLOAD_INSIGHTS_DAYS: i64 = 14;
const MAX_EDGE_DOWNLOAD_INSIGHTS_DAYS: i64 = 90;
const CLOUDFLARE_GRAPHQL_API_URL: &str = "https://api.cloudflare.com/client/v4/graphql";
const EDGE_DOWNLOAD_INSIGHTS_QUERY: &str = r#"
query EdgeDownloadInsights($zoneTag: string, $dailyFilter: filter, $countryFilter: filter, $pathFilter: filter) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      daily: httpRequestsAdaptiveGroups(limit: 2400, filter: $dailyFilter, orderBy: [datetimeHour_ASC]) {
        count
        dimensions {
          datetimeHour
        }
      }
      byCountry: httpRequestsAdaptiveGroups(limit: 15, filter: $countryFilter, orderBy: [count_DESC]) {
        count
        dimensions {
          clientCountryName
        }
      }
      byPath: httpRequestsAdaptiveGroups(limit: 200, filter: $pathFilter, orderBy: [count_DESC]) {
        count
        dimensions {
          clientRequestPath
        }
      }
    }
  }
}
"#;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/downloads/edge-insights", get(get_edge_download_insights))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeDownloadSurface {
    All,
    Desktop,
    Mobile,
}

impl EdgeDownloadSurface {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
        }
    }

    fn path_like(self, desktop_prefix: &str, mobile_prefix: &str) -> String {
        match self {
            Self::All => "%".to_string(),
            Self::Desktop => format!("/{}/%", desktop_prefix.trim_matches('/')),
            Self::Mobile => format!("/{}/%", mobile_prefix.trim_matches('/')),
        }
    }
}

impl FromStr for EdgeDownloadSurface {
    type Err = EdgeDownloadInsightsError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "all" => Ok(Self::All),
            "desktop" => Ok(Self::Desktop),
            "mobile" => Ok(Self::Mobile),
            other => Err(EdgeDownloadInsightsError::Invalid(format!(
                "surface must be one of: all, desktop, mobile (got '{other}')"
            ))),
        }
    }
}

#[derive(Clone, Debug)]
struct ResolvedEdgeDownloadInsightsParams {
    days: i64,
    surface: EdgeDownloadSurface,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EdgeDownloadInsightCounts {
    pub(crate) requests: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EdgeDownloadInsightDay {
    pub(crate) day: String,
    #[serde(flatten)]
    pub(crate) counts: EdgeDownloadInsightCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EdgeDownloadInsightBreakdown {
    pub(crate) key: String,
    pub(crate) label: String,
    #[serde(flatten)]
    pub(crate) counts: EdgeDownloadInsightCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EdgeDownloadInsights {
    pub(crate) days: i64,
    pub(crate) range_start: String,
    pub(crate) range_end: String,
    pub(crate) surface_filter: String,
    pub(crate) totals: EdgeDownloadInsightCounts,
    pub(crate) daily: Vec<EdgeDownloadInsightDay>,
    pub(crate) by_country: Vec<EdgeDownloadInsightBreakdown>,
    pub(crate) by_surface: Vec<EdgeDownloadInsightBreakdown>,
}

#[derive(Debug)]
enum EdgeDownloadInsightsError {
    Invalid(String),
    Unavailable(String),
    Internal(anyhow::Error),
}

impl EdgeDownloadInsightsError {
    fn into_response(self) -> (StatusCode, Json<ApiError>) {
        match self {
            Self::Invalid(message) => bad_request(message),
            Self::Unavailable(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiError::new(message)),
            ),
            Self::Internal(error) => {
                internal_error(format!("edge download analytics error: {error}"))
            }
        }
    }
}

fn edge_internal(error: impl Into<anyhow::Error>) -> EdgeDownloadInsightsError {
    EdgeDownloadInsightsError::Internal(error.into())
}

#[derive(Debug, Deserialize)]
struct CloudflareGraphQlEnvelope<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<CloudflareGraphQlError>,
}

#[derive(Debug, Deserialize)]
struct CloudflareGraphQlError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct CloudflareEdgeAnalyticsData {
    viewer: CloudflareEdgeAnalyticsViewer,
}

#[derive(Debug, Deserialize)]
struct CloudflareEdgeAnalyticsViewer {
    zones: Vec<CloudflareEdgeAnalyticsZone>,
}

#[derive(Debug, Deserialize)]
struct CloudflareEdgeAnalyticsZone {
    daily: Vec<CloudflareHourlyGroup>,
    #[serde(rename = "byCountry")]
    by_country: Vec<CloudflareCountryGroup>,
    #[serde(rename = "byPath")]
    by_path: Vec<CloudflarePathGroup>,
}

#[derive(Debug, Deserialize)]
struct CloudflareHourlyGroup {
    count: i64,
    dimensions: CloudflareHourlyDimensions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareHourlyDimensions {
    datetime_hour: String,
}

#[derive(Debug, Deserialize)]
struct CloudflareCountryGroup {
    count: i64,
    dimensions: CloudflareCountryDimensions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareCountryDimensions {
    client_country_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudflarePathGroup {
    count: i64,
    dimensions: CloudflarePathDimensions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflarePathDimensions {
    client_request_path: Option<String>,
}

async fn get_edge_download_insights(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<EdgeDownloadInsights>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params = parse_edge_download_insights_params(&uri)
        .map_err(EdgeDownloadInsightsError::into_response)?;
    let insights = load_edge_download_insights(&state, params)
        .await
        .map_err(EdgeDownloadInsightsError::into_response)?;
    Ok(Json(insights))
}

async fn load_edge_download_insights(
    state: &AppState,
    params: ResolvedEdgeDownloadInsightsParams,
) -> Result<EdgeDownloadInsights, EdgeDownloadInsightsError> {
    let api_token = state
        .config
        .cloudflare_api_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            EdgeDownloadInsightsError::Unavailable(
                "edge download analytics is not configured: missing CLOUDFLARE_API_TOKEN"
                    .to_string(),
            )
        })?;
    let zone_tag = state
        .config
        .cloudflare_zone_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            EdgeDownloadInsightsError::Unavailable(
                "edge download analytics is not configured: missing CLOUDFLARE_ZONE_ID".to_string(),
            )
        })?;

    let (start_day, end_day, start_at, end_exclusive) = resolve_download_window(params.days)?;
    let host = state.config.downloads_public_host.trim();
    let surface_path_like = params.surface.path_like(
        &state.config.desktop_downloads_prefix,
        &state.config.mobile_ota_downloads_prefix,
    );
    let daily_filter = json!({
        "datetime_geq": start_at.to_rfc3339(),
        "datetime_lt": end_exclusive.to_rfc3339(),
        "clientRequestHTTPHost": host,
        "clientRequestPath_like": surface_path_like,
    });
    let path_filter = json!({
        "datetime_geq": start_at.to_rfc3339(),
        "datetime_lt": end_exclusive.to_rfc3339(),
        "clientRequestHTTPHost": host,
    });

    let response = state
        .http_client
        .post(CLOUDFLARE_GRAPHQL_API_URL)
        .bearer_auth(api_token)
        .json(&json!({
            "query": EDGE_DOWNLOAD_INSIGHTS_QUERY,
            "variables": {
                "zoneTag": zone_tag,
                "dailyFilter": daily_filter,
                "countryFilter": daily_filter,
                "pathFilter": path_filter,
            }
        }))
        .send()
        .await
        .map_err(edge_internal)?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(EdgeDownloadInsightsError::Unavailable(format!(
            "Cloudflare analytics request failed ({status}): {body}"
        )));
    }

    let payload = response
        .json::<CloudflareGraphQlEnvelope<CloudflareEdgeAnalyticsData>>()
        .await
        .map_err(edge_internal)?;

    if !payload.errors.is_empty() {
        let message = payload
            .errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(EdgeDownloadInsightsError::Unavailable(format!(
            "Cloudflare analytics query failed: {message}"
        )));
    }

    let data = payload.data.ok_or_else(|| {
        EdgeDownloadInsightsError::Unavailable("Cloudflare analytics returned no data".to_string())
    })?;
    let zone = data.viewer.zones.into_iter().next().ok_or_else(|| {
        EdgeDownloadInsightsError::Unavailable(
            "Cloudflare analytics returned no zones for the configured zone id".to_string(),
        )
    })?;

    Ok(build_edge_download_insights(
        params,
        start_day,
        end_day,
        zone.daily,
        zone.by_country,
        zone.by_path,
        &state.config.desktop_downloads_prefix,
        &state.config.mobile_ota_downloads_prefix,
    ))
}

fn parse_edge_download_insights_params(
    uri: &Uri,
) -> Result<ResolvedEdgeDownloadInsightsParams, EdgeDownloadInsightsError> {
    let mut days = DEFAULT_EDGE_DOWNLOAD_INSIGHTS_DAYS;
    let mut surface = EdgeDownloadSurface::All;

    if let Some(query) = uri.query() {
        for pair in query.split('&').filter(|segment| !segment.is_empty()) {
            let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
            let key = urlencoding::decode(raw_key)
                .map(|value| value.into_owned())
                .map_err(|error| {
                    EdgeDownloadInsightsError::Invalid(format!("invalid query encoding: {error}"))
                })?;
            let value = urlencoding::decode(raw_value)
                .map(|value| value.into_owned())
                .map_err(|error| {
                    EdgeDownloadInsightsError::Invalid(format!("invalid query encoding: {error}"))
                })?;
            match key.as_str() {
                "days" => {
                    days = value.parse::<i64>().map_err(|error| {
                        EdgeDownloadInsightsError::Invalid(format!(
                            "days must be an integer: {error}"
                        ))
                    })?;
                }
                "surface" => {
                    surface = EdgeDownloadSurface::from_str(&value)?;
                }
                _ => {}
            }
        }
    }

    if days <= 0 {
        return Err(EdgeDownloadInsightsError::Invalid(
            "days must be greater than 0".to_string(),
        ));
    }

    Ok(ResolvedEdgeDownloadInsightsParams {
        days: days.min(MAX_EDGE_DOWNLOAD_INSIGHTS_DAYS),
        surface,
    })
}

fn resolve_download_window(
    days: i64,
) -> Result<(NaiveDate, NaiveDate, DateTime<Utc>, DateTime<Utc>), EdgeDownloadInsightsError> {
    if days <= 0 {
        return Err(EdgeDownloadInsightsError::Invalid(
            "days must be greater than 0".to_string(),
        ));
    }
    let end_day = Utc::now().date_naive();
    let start_day = end_day - Duration::days(days - 1);
    let start_at = start_day
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| EdgeDownloadInsightsError::Invalid("invalid start day".to_string()))?
        .and_utc();
    let end_exclusive = (end_day + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| EdgeDownloadInsightsError::Invalid("invalid end day".to_string()))?
        .and_utc();
    Ok((start_day, end_day, start_at, end_exclusive))
}

fn build_edge_download_insights(
    params: ResolvedEdgeDownloadInsightsParams,
    start_day: NaiveDate,
    end_day: NaiveDate,
    daily_rows: Vec<CloudflareHourlyGroup>,
    by_country_rows: Vec<CloudflareCountryGroup>,
    by_path_rows: Vec<CloudflarePathGroup>,
    desktop_prefix: &str,
    mobile_prefix: &str,
) -> EdgeDownloadInsights {
    let mut daily_map = BTreeMap::<NaiveDate, i64>::new();
    for row in daily_rows {
        if let Some(day) = parse_hour_to_day(&row.dimensions.datetime_hour) {
            *daily_map.entry(day).or_default() += row.count;
        }
    }

    let mut totals = EdgeDownloadInsightCounts::default();
    let mut daily = Vec::new();
    let mut cursor = start_day;
    while cursor <= end_day {
        let requests = daily_map.get(&cursor).copied().unwrap_or_default();
        totals.requests += requests;
        daily.push(EdgeDownloadInsightDay {
            day: cursor.to_string(),
            counts: EdgeDownloadInsightCounts { requests },
        });
        cursor += Duration::days(1);
    }

    let mut by_country = by_country_rows
        .into_iter()
        .map(|row| {
            let key = normalize_country_label(row.dimensions.client_country_name.as_deref());
            EdgeDownloadInsightBreakdown {
                label: key.clone(),
                key,
                counts: EdgeDownloadInsightCounts {
                    requests: row.count,
                },
            }
        })
        .collect::<Vec<_>>();
    by_country.sort_by(|left, right| {
        right
            .counts
            .requests
            .cmp(&left.counts.requests)
            .then(left.label.cmp(&right.label))
    });

    let mut surface_counts = BTreeMap::<String, i64>::new();
    for row in by_path_rows {
        let surface = classify_download_surface(
            row.dimensions.client_request_path.as_deref().unwrap_or(""),
            desktop_prefix,
            mobile_prefix,
        );
        *surface_counts.entry(surface.key().to_string()).or_default() += row.count;
    }
    let mut by_surface = surface_counts
        .into_iter()
        .map(|(key, requests)| {
            let surface = EdgeDownloadSurfaceBreakdown::from_key(&key);
            EdgeDownloadInsightBreakdown {
                key,
                label: surface.label().to_string(),
                counts: EdgeDownloadInsightCounts { requests },
            }
        })
        .collect::<Vec<_>>();
    by_surface.sort_by(|left, right| {
        right
            .counts
            .requests
            .cmp(&left.counts.requests)
            .then(left.label.cmp(&right.label))
    });

    EdgeDownloadInsights {
        days: params.days,
        range_start: start_day.to_string(),
        range_end: end_day.to_string(),
        surface_filter: params.surface.as_str().to_string(),
        totals,
        daily,
        by_country,
        by_surface,
    }
}

fn parse_hour_to_day(value: &str) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.date_naive())
        .ok()
}

fn normalize_country_label(value: Option<&str>) -> String {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return "unknown".to_string();
    };
    let upper = value.to_ascii_uppercase();
    if upper.len() == 2 && upper.chars().all(|ch| ch.is_ascii_uppercase()) {
        return upper;
    }
    value.to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeDownloadSurfaceBreakdown {
    Desktop,
    Mobile,
    Other,
}

impl EdgeDownloadSurfaceBreakdown {
    fn key(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
            Self::Other => "other",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Desktop => "Desktop",
            Self::Mobile => "Mobile OTA",
            Self::Other => "Other",
        }
    }

    fn from_key(value: &str) -> Self {
        match value {
            "desktop" => Self::Desktop,
            "mobile" => Self::Mobile,
            _ => Self::Other,
        }
    }
}

fn classify_download_surface(
    path: &str,
    desktop_prefix: &str,
    mobile_prefix: &str,
) -> EdgeDownloadSurfaceBreakdown {
    let normalized = path.trim();
    let desktop_prefix = format!("/{}/", desktop_prefix.trim_matches('/'));
    if normalized.starts_with(&desktop_prefix)
        || normalized == format!("/{}/latest.json", desktop_prefix.trim_matches('/'))
    {
        return EdgeDownloadSurfaceBreakdown::Desktop;
    }

    let mobile_prefix = format!("/{}/", mobile_prefix.trim_matches('/'));
    if normalized.starts_with(&mobile_prefix) {
        return EdgeDownloadSurfaceBreakdown::Mobile;
    }

    EdgeDownloadSurfaceBreakdown::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_download_surfaces_from_paths() {
        assert_eq!(
            classify_download_surface("/desktop-app/stable/latest.json", "desktop-app", "mobile"),
            EdgeDownloadSurfaceBreakdown::Desktop
        );
        assert_eq!(
            classify_download_surface("/desktop-app/latest.json", "desktop-app", "mobile"),
            EdgeDownloadSurfaceBreakdown::Desktop
        );
        assert_eq!(
            classify_download_surface("/mobile/2026.03.23.1.zip", "desktop-app", "mobile"),
            EdgeDownloadSurfaceBreakdown::Mobile
        );
        assert_eq!(
            classify_download_surface("/robots.txt", "desktop-app", "mobile"),
            EdgeDownloadSurfaceBreakdown::Other
        );
    }

    #[test]
    fn builds_daily_country_and_surface_breakdowns() {
        let insights = build_edge_download_insights(
            ResolvedEdgeDownloadInsightsParams {
                days: 3,
                surface: EdgeDownloadSurface::All,
            },
            NaiveDate::from_ymd_opt(2026, 3, 21).expect("date"),
            NaiveDate::from_ymd_opt(2026, 3, 23).expect("date"),
            vec![
                CloudflareHourlyGroup {
                    count: 4,
                    dimensions: CloudflareHourlyDimensions {
                        datetime_hour: "2026-03-22T12:00:00Z".to_string(),
                    },
                },
                CloudflareHourlyGroup {
                    count: 3,
                    dimensions: CloudflareHourlyDimensions {
                        datetime_hour: "2026-03-23T08:00:00Z".to_string(),
                    },
                },
            ],
            vec![
                CloudflareCountryGroup {
                    count: 5,
                    dimensions: CloudflareCountryDimensions {
                        client_country_name: Some("AT".to_string()),
                    },
                },
                CloudflareCountryGroup {
                    count: 2,
                    dimensions: CloudflareCountryDimensions {
                        client_country_name: Some("US".to_string()),
                    },
                },
            ],
            vec![
                CloudflarePathGroup {
                    count: 4,
                    dimensions: CloudflarePathDimensions {
                        client_request_path: Some("/desktop-app/stable/latest.json".to_string()),
                    },
                },
                CloudflarePathGroup {
                    count: 3,
                    dimensions: CloudflarePathDimensions {
                        client_request_path: Some("/mobile/2026.03.23.1.zip".to_string()),
                    },
                },
            ],
            "desktop-app",
            "mobile",
        );

        assert_eq!(insights.totals.requests, 7);
        assert_eq!(insights.daily.len(), 3);
        assert_eq!(insights.daily[0].counts.requests, 0);
        assert_eq!(insights.daily[1].counts.requests, 4);
        assert_eq!(insights.daily[2].counts.requests, 3);
        assert_eq!(insights.by_country[0].key, "AT");
        assert_eq!(insights.by_surface[0].key, "desktop");
        assert_eq!(insights.by_surface[1].key, "mobile");
    }
}
