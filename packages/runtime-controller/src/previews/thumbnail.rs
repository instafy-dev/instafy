//! A small picture of a site preview, for its card in the conversation.
//!
//! The runtime that serves a preview uploads it (`PUT …/thumbnail`, a job or
//! machine token bound to that runtime, as `/ready` checks): `instafy preview
//! open` once the site is live, `instafy preview check` after a change, or a
//! picture a skill made itself. People cannot upload one.
//!
//! The controller decides the format from the bytes (JPEG, PNG or WebP; never
//! SVG or GIF), reads the size from the header and removes metadata segments
//! (EXIF, XMP, ICC, comments, text chunks, anything after the image) without
//! decoding pixels, so a picture cannot carry a location or a note. One
//! picture per preview, in a controller-only table. Every open of the preview
//! drops it (the port may serve another site now), as do a close and a
//! replacement; a machine that only sleeps keeps it.
//!
//! It is read only here (`GET …/thumbnail`), with the rule `GET` of the
//! preview uses: members who may open the preview. The answer is `private,
//! no-store`, so a person whose access ends keeps no copy on disk; Studio
//! keeps it in memory only. Never a Storage object, a public or signed URL,
//! a notification or part of a message: the card names the preview by id.
//! Each upload publishes `preview.thumbnail_updated` (ids and the version
//! only) to the audience `preview.wake` has.

use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_postgres::error::SqlState;
use tracing::{instrument, warn};
use uuid::Uuid;

use super::{
    authorize_preview_reader, ensure_previews_available, identify_preview_caller,
    load_preview_grant, preview_visible_to, ApiResult, PreviewCaller, PreviewGrant, PreviewPath,
};
use crate::config::PgPool;
use crate::state::publish_controller_event_with_conversation;
use crate::tunnels::parse_required_uuid;
use crate::{
    bad_request, forbidden, internal_error, not_found, too_many_requests, ApiError, AppState,
};

/// The largest picture kept, after its metadata is removed.
pub(super) const THUMBNAIL_MAX_BYTES: usize = 512 * 1024;
/// The upload body: the picture as base64 plus a few short fields.
pub(super) const THUMBNAIL_UPLOAD_MAX_BODY_BYTES: usize = 768 * 1024;
const THUMBNAIL_MIN_SIDE: u32 = 64;
const THUMBNAIL_MAX_SIDE: u32 = 2000;
pub(super) const THUMBNAILS_PER_PREVIEW_PER_MINUTE: usize = 6;
pub(super) const THUMBNAILS_PER_RUNTIME_PER_HOUR: usize = 60;
pub(super) const PAGE_DESCRIPTION_MAX_CHARS: usize = 300;
pub(crate) const THUMBNAIL_EVENT_KIND: &str = "preview.thumbnail_updated";
/// A picture's version is the start of its sha256: the key Studio caches it under.
const VERSION_CHARS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ImageFormat {
    Jpeg,
    Png,
    Webp,
}

impl ImageFormat {
    pub(super) fn content_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }

    fn from_content_type(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "image/jpeg" => Some(Self::Jpeg),
            "image/png" => Some(Self::Png),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    /// What the first bytes say the file is, whatever it claims.
    fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(&PNG_SIGNATURE) {
            Some(Self::Png)
        } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }
}

/// A picture as it is kept: its format, its size from the header, and its
/// bytes with every metadata segment removed.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct CleanImage {
    pub(super) format: ImageFormat,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) bytes: Vec<u8>,
}

/// Read a JPEG, PNG or WebP by its structure alone and rewrite it without
/// metadata. `None` when it is none of those, or not well formed.
pub(super) fn clean_image(bytes: &[u8]) -> Option<CleanImage> {
    let format = ImageFormat::sniff(bytes)?;
    let (bytes, width, height) = match format {
        ImageFormat::Jpeg => clean_jpeg(bytes)?,
        ImageFormat::Png => clean_png(bytes)?,
        ImageFormat::Webp => clean_webp(bytes)?,
    };
    (width > 0 && height > 0).then_some(CleanImage {
        format,
        width,
        height,
        bytes,
    })
}

fn is_jpeg_frame_header(marker: u8) -> bool {
    matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF)
}

/// The segments a JPEG needs to be drawn: frame headers, tables, restart
/// intervals and scans, and Adobe's fixed-size colour transform marker.
/// Every application segment that can hold text or data (JFIF and its
/// thumbnails, EXIF, XMP, ICC, IPTC, …) and every comment is left out.
fn keep_jpeg_segment(marker: u8, segment: &[u8]) -> bool {
    match marker {
        0xC0..=0xC7 | 0xC9..=0xCF | 0xDA..=0xDF => true,
        // APP14 "Adobe": 12 bytes of colour transform flags, no data.
        0xEE => segment.len() == 14 && segment.get(2..7) == Some(b"Adobe".as_slice()),
        _ => false,
    }
}

fn clean_jpeg(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&[0xFF, 0xD8]);
    let mut pos = 2;
    let mut size: Option<(u32, u32)> = None;
    loop {
        if *bytes.get(pos)? != 0xFF {
            return None;
        }
        // Fill bytes before a marker.
        while bytes.get(pos) == Some(&0xFF) {
            pos += 1;
        }
        let marker = *bytes.get(pos)?;
        pos += 1;
        match marker {
            // End of image: anything after it is dropped.
            0xD9 => {
                out.extend_from_slice(&[0xFF, 0xD9]);
                break;
            }
            0xD0..=0xD7 | 0x01 => {
                out.extend_from_slice(&[0xFF, marker]);
                continue;
            }
            0x00 | 0xD8 => return None,
            _ => {}
        }
        let length = usize::from(u16::from_be_bytes([*bytes.get(pos)?, *bytes.get(pos + 1)?]));
        if length < 2 {
            return None;
        }
        let end = pos.checked_add(length)?;
        let segment = bytes.get(pos..end)?;
        if is_jpeg_frame_header(marker) {
            if segment.len() < 7 {
                return None;
            }
            let height = u32::from(u16::from_be_bytes([segment[3], segment[4]]));
            let width = u32::from(u16::from_be_bytes([segment[5], segment[6]]));
            size.get_or_insert((width, height));
        }
        let keep = keep_jpeg_segment(marker, segment);
        if keep {
            out.extend_from_slice(&[0xFF, marker]);
            out.extend_from_slice(segment);
        }
        pos = end;
        if marker == 0xDA {
            // Entropy-coded data runs to the next marker: a 0xFF that is not
            // a stuffed 0xFF00 or a restart marker.
            let start = pos;
            loop {
                let next = pos + bytes.get(pos..)?.iter().position(|byte| *byte == 0xFF)?;
                let following = *bytes.get(next + 1)?;
                if following == 0x00 || (0xD0..=0xD7).contains(&following) {
                    pos = next + 2;
                    continue;
                }
                pos = next;
                break;
            }
            out.extend_from_slice(&bytes[start..pos]);
        }
    }
    let (width, height) = size?;
    Some((out, width, height))
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The chunks a PNG needs to be drawn as one still image. Text (tEXt, zTXt,
/// iTXt), EXIF, ICC profiles, times, animation and unknown chunks are left out.
const PNG_KEPT_CHUNKS: [&[u8; 4]; 11] = [
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"sBIT", b"bKGD",
    b"pHYs",
];

fn clean_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut out = PNG_SIGNATURE.to_vec();
    let mut pos = PNG_SIGNATURE.len();
    let mut size: Option<(u32, u32)> = None;
    loop {
        let length = usize::try_from(u32::from_be_bytes(
            bytes.get(pos..pos + 4)?.try_into().ok()?,
        ))
        .ok()?;
        let kind: &[u8; 4] = bytes.get(pos + 4..pos + 8)?.try_into().ok()?;
        let end = pos.checked_add(12)?.checked_add(length)?;
        let chunk = bytes.get(pos..end)?;
        if size.is_none() {
            if kind != b"IHDR" || length < 8 {
                return None;
            }
            let width = u32::from_be_bytes(chunk[8..12].try_into().ok()?);
            let height = u32::from_be_bytes(chunk[12..16].try_into().ok()?);
            size = Some((width, height));
        }
        if PNG_KEPT_CHUNKS.contains(&kind) {
            out.extend_from_slice(chunk);
        }
        pos = end;
        if kind == b"IEND" {
            break;
        }
    }
    let (width, height) = size?;
    Some((out, width, height))
}

/// VP8X flags for an ICC profile, EXIF and XMP: cleared with their chunks.
const WEBP_METADATA_FLAGS: u8 = 0x20 | 0x08 | 0x04;
const WEBP_ANIMATION_FLAG: u8 = 0x02;

/// A still WebP: its image chunk (VP8 or VP8L), its alpha and its VP8X header
/// without the metadata flags. ICC, EXIF, XMP and unknown chunks are left
/// out; an animated WebP is refused.
fn clean_webp(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let declared = usize::try_from(u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?)).ok()?;
    let end_of_file = declared.checked_add(8)?;
    let body = bytes.get(12..end_of_file)?;
    let mut chunks: Vec<u8> = Vec::with_capacity(body.len());
    let mut pos = 0;
    let mut size: Option<(u32, u32)> = None;
    let mut images = 0;
    while pos < body.len() {
        let kind: [u8; 4] = body.get(pos..pos + 4)?.try_into().ok()?;
        let length = usize::try_from(u32::from_le_bytes(
            body.get(pos + 4..pos + 8)?.try_into().ok()?,
        ))
        .ok()?;
        let data_end = pos.checked_add(8)?.checked_add(length)?;
        let data = body.get(pos + 8..data_end)?;
        let padded_end = data_end + (length % 2);
        let keep = match &kind {
            b"VP8X" => {
                if data.len() < 10 || data[0] & WEBP_ANIMATION_FLAG != 0 {
                    return None;
                }
                let width = 1 + u32::from_le_bytes([data[4], data[5], data[6], 0]);
                let height = 1 + u32::from_le_bytes([data[7], data[8], data[9], 0]);
                size = Some((width, height));
                let mut header = data.to_vec();
                header[0] &= !WEBP_METADATA_FLAGS;
                chunks.extend_from_slice(b"VP8X");
                chunks.extend_from_slice(&(header.len() as u32).to_le_bytes());
                chunks.extend_from_slice(&header);
                if header.len() % 2 == 1 {
                    chunks.push(0);
                }
                false
            }
            b"VP8 " => {
                // A key frame: 3 bytes of frame tag, the start code, then 14-bit sizes.
                if data.len() < 10 || data[3..6] != [0x9D, 0x01, 0x2A] {
                    return None;
                }
                let width = u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3FFF);
                let height = u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3FFF);
                size.get_or_insert((width, height));
                images += 1;
                true
            }
            b"VP8L" => {
                if data.len() < 5 || data[0] != 0x2F {
                    return None;
                }
                let bits = u32::from_le_bytes([data[1], data[2], data[3], data[4]]);
                let width = 1 + (bits & 0x3FFF);
                let height = 1 + ((bits >> 14) & 0x3FFF);
                size.get_or_insert((width, height));
                images += 1;
                true
            }
            b"ALPH" => true,
            b"ANIM" | b"ANMF" => return None,
            _ => false,
        };
        if keep {
            chunks.extend_from_slice(body.get(pos..padded_end.min(body.len()))?);
            if padded_end > body.len() {
                chunks.push(0);
            }
        }
        pos = padded_end;
    }
    if images != 1 {
        return None;
    }
    let (width, height) = size?;
    let mut out = Vec::with_capacity(chunks.len() + 12);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&u32::try_from(chunks.len() + 4).ok()?.to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&chunks);
    Some((out, width, height))
}

/// A page's own description as the card may show it: one line, no control or
/// bidi-override characters, at most 300 characters. `None` when nothing is left.
pub(super) fn clean_page_description(raw: &str) -> Option<String> {
    let mut text = String::new();
    for word in raw
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
    {
        let word: String = word.chars().filter(|c| !is_bidi_control(*c)).collect();
        if word.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&word);
    }
    let text: String = text.chars().take(PAGE_DESCRIPTION_MAX_CHARS).collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub(super) fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThumbnailSource {
    Capture,
    OgImage,
    File,
}

impl ThumbnailSource {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "capture" => Some(Self::Capture),
            "og_image" => Some(Self::OgImage),
            "file" => Some(Self::File),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::OgImage => "og_image",
            Self::File => "file",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThumbnailUploadBody {
    image: String,
    content_type: String,
    source: String,
    /// The page's own `<meta name="description">`, read where the picture was taken.
    #[serde(default)]
    description: Option<String>,
}

/// What `GET` of a preview says about its picture. No bytes and no address:
/// Studio asks for the picture by preview and version.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThumbnailView {
    pub(super) version: String,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) captured_at: String,
}

fn version_of(sha256: &str) -> String {
    sha256.chars().take(VERSION_CHARS).collect()
}

fn thumbnail_too_large() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(ApiError::with_details(
            format!("the picture must be at most {THUMBNAIL_MAX_BYTES} bytes"),
            "thumbnail_too_large",
            json!({ "maxBytes": THUMBNAIL_MAX_BYTES }),
        )),
    )
}

fn is_undefined_table(error: &tokio_postgres::Error) -> bool {
    matches!(
        error.as_db_error().map(|db_error| db_error.code()),
        Some(&SqlState::UNDEFINED_TABLE)
    )
}

async fn enforce_upload_rate(state: &AppState, grant: &PreviewGrant) -> ApiResult<()> {
    let limited = |limit: crate::rate_limit::RateLimitExceeded| {
        let seconds = limit.retry_after.as_secs().max(1);
        too_many_requests(format!(
            "Too many preview pictures uploaded. Try again in {seconds}s."
        ))
    };
    state
        .rate_limiter
        .enforce(
            format!("preview-thumbnail:{}", grant.record.tunnel_id),
            THUMBNAILS_PER_PREVIEW_PER_MINUTE,
            Duration::from_secs(60),
        )
        .await
        .map_err(limited)?;
    if let Some(runtime_id) = grant.record.runtime_id {
        state
            .rate_limiter
            .enforce(
                format!("preview-thumbnail-runtime:{runtime_id}"),
                THUMBNAILS_PER_RUNTIME_PER_HOUR,
                Duration::from_secs(60 * 60),
            )
            .await
            .map_err(limited)?;
    }
    Ok(())
}

/// `PUT /projects/:id/previews/:pid/thumbnail`: the preview's own runtime
/// replaces its picture.
#[instrument(skip(state, headers, body))]
pub(super) async fn put_preview_thumbnail(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
    Json(body): Json<ThumbnailUploadBody>,
) -> ApiResult<Json<ThumbnailView>> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let caller = identify_preview_caller(&state, &headers, &project_id).await?;
    let grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    match &caller {
        PreviewCaller::Human(_) => {
            return Err(forbidden(
                "only the runtime that serves a preview uploads its picture",
            ));
        }
        PreviewCaller::Job { runtime_id, .. } if grant.record.runtime_id != Some(*runtime_id) => {
            return Err(forbidden("preview belongs to another runtime"));
        }
        PreviewCaller::Machine {
            runtime_id,
            runtime_lease_id,
            ..
        } if grant.record.runtime_id != Some(*runtime_id)
            || grant.record.runtime_lease_id != *runtime_lease_id =>
        {
            return Err(forbidden("preview belongs to another runtime"));
        }
        _ => {}
    }
    if !grant.is_live() || grant.is_closed() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("this preview is closed")),
        ));
    }

    let claimed = ImageFormat::from_content_type(&body.content_type)
        .ok_or_else(|| bad_request("contentType must be image/jpeg, image/png or image/webp"))?;
    let source = ThumbnailSource::parse(&body.source)
        .ok_or_else(|| bad_request("source must be capture, og_image or file"))?;
    // base64 of the largest picture, with room for line breaks.
    if body.image.len() > THUMBNAIL_MAX_BYTES / 3 * 4 + 1024 {
        return Err(thumbnail_too_large());
    }
    let compact: String = body
        .image
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let raw = STANDARD
        .decode(compact.as_bytes())
        .map_err(|_| bad_request("image must be base64"))?;
    if raw.len() > THUMBNAIL_MAX_BYTES {
        return Err(thumbnail_too_large());
    }
    if ImageFormat::sniff(&raw) != Some(claimed) {
        return Err(bad_request(format!(
            "the picture is not a {} (only JPEG, PNG and WebP are kept)",
            claimed.content_type()
        )));
    }
    let image = clean_image(&raw).ok_or_else(|| bad_request("the picture could not be read"))?;
    let side = THUMBNAIL_MIN_SIDE..=THUMBNAIL_MAX_SIDE;
    if !side.contains(&image.width) || !side.contains(&image.height) {
        return Err(bad_request(format!(
            "the picture must be {THUMBNAIL_MIN_SIDE} to {THUMBNAIL_MAX_SIDE} pixels each way"
        )));
    }
    let description = body.description.as_deref().and_then(clean_page_description);
    let sha256 = hex::encode(Sha256::digest(&image.bytes));
    let width = i32::try_from(image.width).map_err(|_| bad_request("picture too wide"))?;
    let height = i32::try_from(image.height).map_err(|_| bad_request("picture too tall"))?;
    // Counted for pictures that would be kept: a refused one writes nothing.
    enforce_upload_rate(&state, &grant).await?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = connection
        .query_opt(
            "insert into runtime_preview_thumbnails
               (tunnel_id, project_id, runtime_id, content_type, bytes, width, height, sha256,
                source, page_description, captured_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
             on conflict (tunnel_id) do update
               set runtime_id = excluded.runtime_id,
                   content_type = excluded.content_type,
                   bytes = excluded.bytes,
                   width = excluded.width,
                   height = excluded.height,
                   sha256 = excluded.sha256,
                   source = excluded.source,
                   page_description = excluded.page_description,
                   captured_at = now(),
                   updated_at = now()
               where runtime_preview_thumbnails.project_id = excluded.project_id
             returning captured_at",
            &[
                &grant.record.tunnel_id,
                &project_id,
                &grant.record.runtime_id,
                &image.format.content_type(),
                &image.bytes,
                &width,
                &height,
                &sha256,
                &source.as_str(),
                &description,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to store the preview picture: {error}")))?
        .ok_or_else(|| not_found("preview not found"))?;
    drop(connection);
    let captured_at: DateTime<Utc> = row.get("captured_at");
    let view = ThumbnailView {
        version: version_of(&sha256),
        width: image.width,
        height: image.height,
        captured_at: captured_at.to_rfc3339(),
    };
    publish_thumbnail_event(&state, &project_id, &grant, &view.version);
    Ok(Json(view))
}

/// `preview.thumbnail_updated` carries the preview's conversation (as the
/// event's conversation id) and runtime, as `preview.wake` does, so the
/// private-conversation and private-runtime filters on `/events` apply. It
/// carries no picture and no description.
pub(super) fn thumbnail_event_data(
    preview_id: &str,
    version: &str,
    runtime_id: Option<Uuid>,
) -> serde_json::Value {
    let mut data = json!({ "previewId": preview_id, "version": version });
    if let Some(runtime_id) = runtime_id {
        data["runtimeId"] = json!(runtime_id);
    }
    data
}

fn publish_thumbnail_event(
    state: &AppState,
    project_id: &Uuid,
    grant: &PreviewGrant,
    version: &str,
) {
    let conversation_id = grant
        .preview_str("conversationId")
        .and_then(|id| Uuid::parse_str(id).ok());
    publish_controller_event_with_conversation(
        &state.events,
        THUMBNAIL_EVENT_KIND,
        Some(*project_id),
        None,
        conversation_id,
        None,
        None,
        thumbnail_event_data(&grant.record.tunnel_id, version, grant.record.runtime_id),
    );
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct ThumbnailQuery {
    /// The version the card asks for; only a cache key for the browser.
    #[serde(default)]
    #[allow(dead_code)]
    v: Option<String>,
}

/// `GET /projects/:id/previews/:pid/thumbnail`: the picture, for those who
/// may open the preview.
#[instrument(skip(state, headers))]
pub(super) async fn get_preview_thumbnail(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    Query(_query): Query<ThumbnailQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let reader = authorize_preview_reader(&state, &headers, &project_id).await?;
    let grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    if grant.is_closed() || !preview_visible_to(&state, &project_id, &grant, &reader).await? {
        return Err(not_found("preview not found"));
    }
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = match connection
        .query_opt(
            "select content_type, bytes from runtime_preview_thumbnails
             where project_id = $1 and tunnel_id = $2",
            &[&project_id, &grant.record.tunnel_id],
        )
        .await
    {
        Ok(row) => row,
        Err(error) if is_undefined_table(&error) => None,
        Err(error) => {
            return Err(internal_error(format!(
                "failed to load the preview picture: {error}"
            )))
        }
    };
    let row = row.ok_or_else(|| not_found("this preview has no picture"))?;
    let content_type: String = row.get("content_type");
    let bytes: Vec<u8> = row.get("bytes");
    // Only the three types the upload allows, whatever the row says.
    let content_type = ImageFormat::from_content_type(&content_type)
        .ok_or_else(|| not_found("this preview has no picture"))?
        .content_type();
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    Ok(response)
}

/// What `GET` of a preview says about its picture, and the page description
/// read with it. `None` when it has none (or the table is not there yet).
pub(super) async fn load_thumbnail_view(
    pool: &PgPool,
    project_id: &Uuid,
    tunnel_id: &str,
) -> ApiResult<Option<(ThumbnailView, Option<String>)>> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = match connection
        .query_opt(
            "select sha256, width, height, captured_at, page_description
             from runtime_preview_thumbnails
             where project_id = $1 and tunnel_id = $2",
            &[project_id, &tunnel_id],
        )
        .await
    {
        Ok(row) => row,
        Err(error) if is_undefined_table(&error) => None,
        Err(error) => {
            return Err(internal_error(format!(
                "failed to load the preview picture: {error}"
            )))
        }
    };
    Ok(row.map(|row| {
        let sha256: String = row.get("sha256");
        let captured_at: DateTime<Utc> = row.get("captured_at");
        (
            ThumbnailView {
                version: version_of(&sha256),
                width: u32::try_from(row.get::<_, i32>("width")).unwrap_or(0),
                height: u32::try_from(row.get::<_, i32>("height")).unwrap_or(0),
                captured_at: captured_at.to_rfc3339(),
            },
            row.get::<_, Option<String>>("page_description"),
        )
    }))
}

/// Forget the pictures of previews that were replaced, opened again (a later
/// site on the same port shares the preview's id) or closed for good. A
/// closed or replaced card reads Stopped; the next open of the port takes a
/// new picture. A preview closed on purpose that a wake can start again keeps
/// its picture for when it does (`forget_closed_preview_picture`). Logged,
/// never fatal: a picture left behind is unreadable while its preview is
/// closed.
pub(super) async fn delete_preview_thumbnails(
    pool: &PgPool,
    project_id: &Uuid,
    tunnel_ids: &[String],
) {
    if tunnel_ids.is_empty() {
        return;
    }
    let result = match pool.get().await {
        Ok(connection) => connection
            .execute(
                "delete from runtime_preview_thumbnails
                 where project_id = $1 and tunnel_id = any($2)",
                &[project_id, &tunnel_ids],
            )
            .await
            .map(|_| ())
            .or_else(|error| {
                if is_undefined_table(&error) {
                    Ok(())
                } else {
                    Err(error.to_string())
                }
            }),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = result {
        warn!(%project_id, %error, "failed to delete preview pictures");
    }
}
