use anyhow::Context;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::tests::{run, Fixture, Job};
use super::thumbnail::{clean_image, clean_page_description, ImageFormat, THUMBNAIL_MAX_BYTES};
use super::*;

// ---------------------------------------------------------------------------
// Pictures built by hand: real headers and segments, so the structure walk is
// what is tested. Nothing here is decoded.

/// A segment: marker, big-endian length (which counts itself), data.
fn jpeg_segment(marker: u8, data: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, marker];
    out.extend_from_slice(&u16::try_from(data.len() + 2).unwrap().to_be_bytes());
    out.extend_from_slice(data);
    out
}

const GPS_NOTE: &[u8] = b"GPS 59.3293N 18.0686E";
const XMP_NOTE: &[u8] = b"<x:xmpmeta>creator: someone@example.com</x:xmpmeta>";

pub(super) fn jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8];
    out.extend(jpeg_segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend_from_slice(GPS_NOTE);
    out.extend(jpeg_segment(0xE1, &exif));
    let mut xmp = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
    xmp.extend_from_slice(XMP_NOTE);
    out.extend(jpeg_segment(0xE1, &xmp));
    out.extend(jpeg_segment(0xE2, b"ICC_PROFILE\0\x01\x01profile"));
    out.extend(jpeg_segment(0xFE, b"a comment"));
    out.extend(jpeg_segment(0xDB, &[0u8; 65]));
    let mut frame = vec![8];
    frame.extend_from_slice(&height.to_be_bytes());
    frame.extend_from_slice(&width.to_be_bytes());
    frame.extend_from_slice(&[1, 1, 0x11, 0]);
    out.extend(jpeg_segment(0xC0, &frame));
    out.extend(jpeg_segment(0xC4, &[0u8; 20]));
    out.extend(jpeg_segment(0xDA, &[1, 1, 0, 0, 63, 0]));
    // Scan data with a stuffed 0xFF00 and a restart marker.
    out.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56]);
    out.extend_from_slice(&[0xFF, 0xD9]);
    out.extend_from_slice(b"TRAILER after the image");
    out
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0, 0, 0, 0]);
    out
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut header = width.to_be_bytes().to_vec();
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    out.extend(png_chunk(b"IHDR", &header));
    out.extend(png_chunk(b"tEXt", b"Comment\0someone@example.com"));
    out.extend(png_chunk(b"eXIf", GPS_NOTE));
    out.extend(png_chunk(b"iCCP", b"profile\0\0data"));
    out.extend(png_chunk(b"IDAT", &[0x78, 0x9C, 1, 2, 3]));
    out.extend(png_chunk(b"IEND", &[]));
    out.extend_from_slice(b"TRAILER");
    out
}

fn webp_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = kind.to_vec();
    out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
    out
}

fn webp(width: u32, height: u32) -> Vec<u8> {
    let mut extended = vec![0x20 | 0x08 | 0x04, 0, 0, 0];
    extended.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    extended.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    let mut lossy = vec![0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A];
    lossy.extend_from_slice(&u16::try_from(width).unwrap().to_le_bytes());
    lossy.extend_from_slice(&u16::try_from(height).unwrap().to_le_bytes());
    lossy.extend_from_slice(&[7, 7, 7]);
    let mut chunks = webp_chunk(b"VP8X", &extended);
    chunks.extend(webp_chunk(b"ICCP", b"profile"));
    chunks.extend(webp_chunk(b"VP8 ", &lossy));
    chunks.extend(webp_chunk(b"EXIF", GPS_NOTE));
    chunks.extend(webp_chunk(b"XMP ", XMP_NOTE));
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&u32::try_from(chunks.len() + 4).unwrap().to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend(chunks);
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn a_jpeg_keeps_its_frame_and_scan_and_loses_exif_xmp_icc_comments_and_trailers() {
    let image = clean_image(&jpeg(640, 400)).expect("a JPEG");
    assert_eq!(image.format, ImageFormat::Jpeg);
    assert_eq!((image.width, image.height), (640, 400));
    for note in [
        GPS_NOTE,
        XMP_NOTE,
        b"ICC_PROFILE".as_slice(),
        b"a comment",
        b"JFIF",
        b"TRAILER",
    ] {
        assert!(
            !contains(&image.bytes, note),
            "{}",
            String::from_utf8_lossy(note)
        );
    }
    assert!(image.bytes.starts_with(&[0xFF, 0xD8]));
    assert!(image.bytes.ends_with(&[0xFF, 0xD9]));
    // The scan, with its stuffed byte and restart marker, is untouched.
    assert!(contains(
        &image.bytes,
        &[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56]
    ));
    // Cleaning is stable.
    assert_eq!(clean_image(&image.bytes).unwrap().bytes, image.bytes);
}

#[test]
fn a_png_keeps_its_image_chunks_and_loses_text_exif_icc_and_trailers() {
    let image = clean_image(&png(800, 500)).expect("a PNG");
    assert_eq!(image.format, ImageFormat::Png);
    assert_eq!((image.width, image.height), (800, 500));
    for note in [
        GPS_NOTE,
        b"someone@example.com".as_slice(),
        b"tEXt",
        b"iCCP",
        b"TRAILER",
    ] {
        assert!(
            !contains(&image.bytes, note),
            "{}",
            String::from_utf8_lossy(note)
        );
    }
    assert!(contains(&image.bytes, b"IDAT"));
    assert!(contains(&image.bytes, b"IEND"));
}

#[test]
fn a_webp_keeps_its_image_and_loses_exif_xmp_icc_and_their_flags() {
    let image = clean_image(&webp(640, 400)).expect("a WebP");
    assert_eq!(image.format, ImageFormat::Webp);
    assert_eq!((image.width, image.height), (640, 400));
    for note in [GPS_NOTE, XMP_NOTE, b"ICCP".as_slice(), b"EXIF", b"XMP "] {
        assert!(
            !contains(&image.bytes, note),
            "{}",
            String::from_utf8_lossy(note)
        );
    }
    let flags = image.bytes[20];
    assert_eq!(flags & (0x20 | 0x08 | 0x04), 0, "metadata flags cleared");
    let declared = u32::from_le_bytes(image.bytes[4..8].try_into().unwrap()) as usize;
    assert_eq!(declared + 8, image.bytes.len(), "RIFF size rewritten");
}

#[test]
fn svg_gif_animation_and_broken_files_are_not_pictures() {
    for bytes in [
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
        b"GIF89a\x40\x00\x40\x00".to_vec(),
        vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00],
        png(64, 64)[..20].to_vec(),
    ] {
        assert!(clean_image(&bytes).is_none());
    }
    let mut animated = webp(64, 64);
    animated[20] |= 0x02;
    assert!(clean_image(&animated).is_none());
}

#[test]
fn a_page_description_is_one_plain_line_of_at_most_300_characters() {
    assert_eq!(
        clean_page_description("  Trip\n·\t3 days \u{202E}· 14 places  ").as_deref(),
        Some("Trip · 3 days · 14 places")
    );
    assert_eq!(clean_page_description(" \n\t "), None);
    assert_eq!(
        clean_page_description(&"x".repeat(400)).map(|text| text.chars().count()),
        Some(300)
    );
}

#[test]
fn summary_is_validated_like_the_title() {
    assert_eq!(
        validate_preview_summary("  Trip ·\n 3 days  · 14 places ").unwrap(),
        "Trip · 3 days · 14 places"
    );
    for bad in ["", "   ", &"x".repeat(81), "bell\u{7}", "flip\u{202E}ped"] {
        assert!(validate_preview_summary(bad).is_err(), "{bad:?}");
    }
    assert!(validate_preview_summary(&"x".repeat(80)).is_ok());
}

// ---------------------------------------------------------------------------
// The routes

pub(super) fn upload_body(bytes: &[u8], content_type: &str) -> Value {
    json!({
        "image": STANDARD.encode(bytes),
        "contentType": content_type,
        "source": "capture",
        "description": "Trip · 3 days · 14 places",
    })
}

impl Fixture {
    fn thumbnail_path(&self, preview_id: &str) -> String {
        self.path(&format!("/{preview_id}/thumbnail"))
    }

    pub(super) async fn upload(
        &self,
        token: &str,
        preview_id: &str,
        body: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request(token, "PUT", &self.thumbnail_path(preview_id), body)
            .await
    }

    /// The raw answer of `GET …/thumbnail`: status, headers and bytes.
    pub(super) async fn picture(
        &self,
        token: &str,
        preview_id: &str,
    ) -> anyhow::Result<(StatusCode, axum::http::HeaderMap, Vec<u8>)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("{}?v=1", self.thumbnail_path(preview_id)))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
        Ok((status, headers, bytes.to_vec()))
    }

    async fn live_preview(&self, job: &Job) -> anyhow::Result<String> {
        let preview_id = self.open(job).await?;
        self.ready(&job.token, &preview_id).await?;
        Ok(preview_id)
    }

    pub(super) async fn thumbnail_rows(&self, preview_id: &str) -> anyhow::Result<i64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select count(*) from runtime_preview_thumbnails where tunnel_id = $1",
                &[&preview_id],
            )
            .await?
            .get(0))
    }
}

#[tokio::test]
async fn the_previews_runtime_uploads_a_thumbnail_and_get_lists_it() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            let (status, before) = f
                .request(&f.tokens[2], "GET", &f.path(&format!("/{preview_id}")), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::OK, "{before}");
            assert_eq!(before["thumbnail"], Value::Null);
            assert!(before.get("pageDescription").is_none());

            let mut events = f.state.events.subscribe();
            let (status, view) = f
                .upload(&job.token, &preview_id, upload_body(&jpeg(640, 400), "image/jpeg"))
                .await?;
            assert_eq!(status, StatusCode::OK, "{view}");
            assert_eq!(view["width"], json!(640));
            assert_eq!(view["height"], json!(400));
            let version = view["version"].as_str().context("version")?.to_string();
            assert_eq!(version.len(), 16);
            assert!(view["capturedAt"].is_string());

            let event = loop {
                let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                    .await??;
                if event.kind == "preview.thumbnail_updated" {
                    break event;
                }
            };
            // Ids and the version only: no picture, no description.
            assert_eq!(
                event.data,
                json!({ "previewId": preview_id, "version": version, "runtimeId": job.runtime_id })
            );

            // Any member who may open the preview reads it, a viewer included.
            let (status, body) = f
                .request(&f.tokens[2], "GET", &f.path(&format!("/{preview_id}")), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body["thumbnail"],
                json!({ "version": version, "width": 640, "height": 400, "capturedAt": view["capturedAt"] })
            );
            assert_eq!(body["pageDescription"], "Trip · 3 days · 14 places");
            let (status, headers, bytes) = f.picture(&f.tokens[2], &preview_id).await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers["content-type"], "image/jpeg");
            assert_eq!(clean_image(&bytes).map(|image| (image.width, image.height)), Some((640, 400)));
            // The runtime itself may read it back too.
            let (status, _, _) = f.picture(&job.token, &preview_id).await?;
            assert_eq!(status, StatusCode::OK);
            // An outsider may not.
            let (status, _, _) = f.picture(&f.tokens[3], &preview_id).await?;
            assert!(matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND), "{status}");

            // A new picture replaces the old one.
            let (status, next) = f
                .upload(&job.token, &preview_id, upload_body(&png(800, 500), "image/png"))
                .await?;
            assert_eq!(status, StatusCode::OK, "{next}");
            assert_ne!(next["version"], json!(version));
            assert_eq!(f.thumbnail_rows(&preview_id).await?, 1);
            let (_, headers, _) = f.picture(&f.tokens[0], &preview_id).await?;
            assert_eq!(headers["content-type"], "image/png");

            // The card message itself stays ids-only.
            let card: Value = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select metadata from conversation_messages
                     where metadata->'details'->'details'->'preview'->>'previewId' = $1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert!(!card.to_string().contains("thumbnail"), "{card}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn another_runtimes_job_cannot_upload() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            let other = f.job(None).await?;
            let (status, body) = f
                .upload(
                    &other.token,
                    &preview_id,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            let machine = f.machine_token(&other, f.users[0])?;
            let (status, body) = f
                .upload(
                    &machine,
                    &preview_id,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(f.thumbnail_rows(&preview_id).await?, 0);
            // Its own runtime's machine token may.
            let own = f.machine_token(&job, f.users[0])?;
            let (status, body) = f
                .upload(
                    &own,
                    &preview_id,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_person_cannot_upload() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            for token in [&f.tokens[0], &f.tokens[1], &f.tokens[2]] {
                let (status, body) = f
                    .upload(
                        token,
                        &preview_id,
                        upload_body(&jpeg(640, 400), "image/jpeg"),
                    )
                    .await?;
                assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            }
            assert_eq!(f.thumbnail_rows(&preview_id).await?, 0);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn svg_gif_wrong_magic_and_oversize_are_refused() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
            let mut oversize = jpeg(640, 400);
            oversize.splice(2..2, jpeg_segment(0xEF, &[7u8; 60_000]).into_iter().cycle().take(THUMBNAIL_MAX_BYTES));
            for (body, expected) in [
                (upload_body(svg, "image/svg+xml"), StatusCode::BAD_REQUEST),
                (upload_body(svg, "image/png"), StatusCode::BAD_REQUEST),
                (upload_body(b"GIF89a\x40\x00\x40\x00;", "image/gif"), StatusCode::BAD_REQUEST),
                // The bytes say PNG, the claim says JPEG.
                (upload_body(&png(640, 400), "image/jpeg"), StatusCode::BAD_REQUEST),
                // Too small and too large to be a picture of a page.
                (upload_body(&jpeg(32, 32), "image/jpeg"), StatusCode::BAD_REQUEST),
                (upload_body(&jpeg(4000, 400), "image/jpeg"), StatusCode::BAD_REQUEST),
                (upload_body(&oversize, "image/jpeg"), StatusCode::PAYLOAD_TOO_LARGE),
                (json!({ "image": "not base64!", "contentType": "image/jpeg", "source": "capture" }), StatusCode::BAD_REQUEST),
                (json!({ "image": STANDARD.encode(jpeg(640, 400)), "contentType": "image/jpeg", "source": "the web" }), StatusCode::BAD_REQUEST),
            ] {
                let (status, result) = f.upload(&job.token, &preview_id, body).await?;
                assert_eq!(status, expected, "{result}");
            }
            assert_eq!(f.thumbnail_rows(&preview_id).await?, 0);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn uploads_are_rate_limited_per_preview() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            for _ in 0..super::thumbnail::THUMBNAILS_PER_PREVIEW_PER_MINUTE {
                let (status, body) = f
                    .upload(
                        &job.token,
                        &preview_id,
                        upload_body(&jpeg(640, 400), "image/jpeg"),
                    )
                    .await?;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            let (status, body) = f
                .upload(
                    &job.token,
                    &preview_id,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn exif_and_xmp_are_removed_on_upload() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            for (bytes, content_type) in [
                (jpeg(640, 400), "image/jpeg"),
                (png(640, 400), "image/png"),
                (webp(640, 400), "image/webp"),
            ] {
                let (status, body) = f
                    .upload(&job.token, &preview_id, upload_body(&bytes, content_type))
                    .await?;
                assert_eq!(status, StatusCode::OK, "{body}");
                let stored: Vec<u8> = f
                    .state
                    .pool
                    .get()
                    .await?
                    .query_one(
                        "select bytes from runtime_preview_thumbnails where tunnel_id = $1",
                        &[&preview_id],
                    )
                    .await?
                    .get(0);
                assert!(!contains(&stored, GPS_NOTE), "{content_type}: EXIF kept");
                assert!(
                    !contains(&stored, b"someone@example.com"),
                    "{content_type}: text kept"
                );
                assert!(!contains(&stored, b"xmpmeta"), "{content_type}: XMP kept");
                let (_, _, served) = f.picture(&f.tokens[0], &preview_id).await?;
                assert_eq!(served, stored);
            }
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_viewer_who_cannot_see_the_private_runtime_gets_404() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            // A runtime only user 1 may see, with a preview and a picture.
            let private_runtime = Uuid::new_v4();
            let private_tunnel = Uuid::new_v4().to_string();
            let db = f.state.pool.get().await?;
            db.execute(
                "insert into runtimes(id, project_id, provider, status, capabilities)
                 values($1, $2, 'default', 'running', $3)",
                &[
                    &private_runtime,
                    &f.project,
                    &json!({ "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": f.users[1] } }),
                ],
            )
            .await?;
            db.execute(
                "insert into runtime_tunnel_grants
                   (project_id, runtime_id, provider, tunnel_id, hostname, url, status, expires_at, metadata)
                 values($1, $2, 'self_hosted', $3, 'private.rt.localhost', 'https://private.rt.localhost',
                        'active', now() + interval '1 hour', $4)",
                &[
                    &f.project,
                    &private_runtime,
                    &private_tunnel,
                    &json!({
                        "localPort": 4173,
                        (PREVIEW_TUNNEL_METADATA_KEY): { "visibility": "private", "path": "/", "title": "Mine" },
                    }),
                ],
            )
            .await?;
            let image = clean_image(&jpeg(640, 400)).context("jpeg")?;
            db.execute(
                "insert into runtime_preview_thumbnails
                   (tunnel_id, project_id, runtime_id, content_type, bytes, width, height, sha256, source)
                 values($1, $2, $3, 'image/jpeg', $4, 640, 400, $5, 'capture')",
                &[&private_tunnel, &f.project, &private_runtime, &image.bytes, &"a".repeat(64)],
            )
            .await?;
            drop(db);
            let (status, _, bytes) = f.picture(&f.tokens[0], &private_tunnel).await?;
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert!(!contains(&bytes, &image.bytes[..32]));
            let (status, body) = f
                .request(&f.tokens[0], "GET", &f.path(&format!("/{private_tunnel}")), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            let (status, _, served) = f.picture(&f.tokens[1], &private_tunnel).await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(served, image.bytes);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn thumbnail_response_is_no_store_nosniff_and_sandboxed() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            let (status, _, _) = f.picture(&f.tokens[0], &preview_id).await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "no picture yet");
            let (status, body) = f
                .upload(
                    &job.token,
                    &preview_id,
                    upload_body(&webp(640, 400), "image/webp"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let (status, headers, _) = f.picture(&f.tokens[0], &preview_id).await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers["content-type"], "image/webp");
            assert_eq!(headers["cache-control"], "private, no-store");
            assert_eq!(headers["x-content-type-options"], "nosniff");
            assert_eq!(
                headers["content-security-policy"],
                "default-src 'none'; sandbox"
            );
            assert_eq!(headers["content-disposition"], "inline");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn closing_or_superseding_the_preview_deletes_the_thumbnail() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            // Closed on purpose.
            let job = f.job(None).await?;
            let closed = f.live_preview(&job).await?;
            let (status, body) = f
                .upload(
                    &job.token,
                    &closed,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let (status, body) = f
                .request(
                    &job.token,
                    "POST",
                    &f.path(&format!("/{closed}/close")),
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
            assert_eq!(f.thumbnail_rows(&closed).await?, 0);
            let (status, _, _) = f.picture(&f.tokens[0], &closed).await?;
            assert_eq!(status, StatusCode::NOT_FOUND);
            // A closed preview takes no new picture.
            let (status, body) = f
                .upload(
                    &job.token,
                    &closed,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");

            // Replaced: the broker handed the port's key another tunnel.
            let replaced = {
                let (status, body) = f
                    .request(&job.token, "POST", &f.path(""), f.open_body(&job, 4174))
                    .await?;
                assert_eq!(status, StatusCode::CREATED, "{body}");
                body["previewId"].as_str().context("previewId")?.to_string()
            };
            f.ready(&job.token, &replaced).await?;
            let (status, body) = f
                .upload(
                    &job.token,
                    &replaced,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            // Another preview keeps its picture: only the replaced one goes.
            let elsewhere_job = f.job(None).await?;
            let kept = f.live_preview(&elsewhere_job).await?;
            let (status, body) = f
                .upload(
                    &elsewhere_job.token,
                    &kept,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");

            f.broker.remint(&preview_tunnel_key(&job.runtime_id, 4174));
            let next = f.job(Some(&job)).await?;
            let (status, body) = f
                .request(&next.token, "POST", &f.path(""), f.open_body(&next, 4174))
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            assert_ne!(body["previewId"], json!(replaced));
            assert_eq!(f.thumbnail_rows(&replaced).await?, 0);
            assert_eq!(f.thumbnail_rows(&kept).await?, 1);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_summary_is_stored_with_the_preview_and_a_bad_one_is_refused() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let mut body = f.open_body(&job, 4173);
            body["summary"] = json!("Trip  · 3 days\n· 14 places");
            let (status, created) = f
                .request(&job.token, "POST", &f.path(""), body.clone())
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let preview_id = created["previewId"].as_str().context("previewId")?;
            let metadata = f.grant_metadata(preview_id).await?;
            assert_eq!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]["summary"],
                "Trip · 3 days · 14 places"
            );
            let (status, preview) = f
                .request(
                    &f.tokens[2],
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{preview}");
            assert_eq!(preview["summary"], "Trip · 3 days · 14 places");
            for bad in [json!(""), json!("x".repeat(81)), json!("bell\u{7}")] {
                let mut body = body.clone();
                body["summary"] = bad;
                let (status, result) = f.request(&job.token, "POST", &f.path(""), body).await?;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
            }
            // Opening it again without one drops it.
            let (status, _) = f
                .request(&job.token, "POST", &f.path(""), f.open_body(&job, 4173))
                .await?;
            assert_eq!(status, StatusCode::CREATED);
            let (_, preview) = f
                .request(
                    &f.tokens[2],
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert!(preview.get("summary").is_none(), "{preview}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn another_site_opened_on_the_same_port_does_not_show_the_earlier_sites_picture(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            let (status, body) = f
                .upload(
                    &job.token,
                    &preview_id,
                    upload_body(&jpeg(640, 400), "image/jpeg"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");

            // Octo serves another site on the same port, saying it replaces
            // the first: the broker hands the port's key the same tunnel, so
            // it is the same preview id.
            let mut body = f.open_body(&job, 4173);
            body["title"] = json!("Tiny Hello");
            body["replace"] = json!(true);
            let (status, created) = f.request(&job.token, "POST", &f.path(""), body).await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            assert_eq!(created["previewId"], json!(preview_id));

            // The map's picture and description are not the hello page's.
            assert_eq!(f.thumbnail_rows(&preview_id).await?, 0);
            f.ready(&job.token, &preview_id).await?;
            let (status, preview) = f
                .request(
                    &f.tokens[2],
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{preview}");
            assert_eq!(preview["title"], "Tiny Hello");
            assert_eq!(preview["thumbnail"], Value::Null);
            assert!(preview.get("pageDescription").is_none(), "{preview}");
            let (status, _, _) = f.picture(&f.tokens[2], &preview_id).await?;
            assert_eq!(status, StatusCode::NOT_FOUND);

            // The new site's own picture is kept as usual.
            let (status, body) = f
                .upload(
                    &job.token,
                    &preview_id,
                    upload_body(&png(800, 500), "image/png"),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(f.thumbnail_rows(&preview_id).await?, 1);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn the_thumbnail_event_reaches_the_audience_a_wake_event_reaches() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.live_preview(&job).await?;
            // A preview opened from a conversation's turn names it, as the
            // wake event's own test sets it up.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_tunnel_grants
                     set metadata = jsonb_set(metadata, '{_instafyPreview,conversationId}', to_jsonb($2::text))
                     where tunnel_id = $1",
                    &[&preview_id, &f.conversation.to_string()],
                )
                .await?;
            let mut events = f.state.events.subscribe();
            let (status, view) = f
                .upload(&job.token, &preview_id, upload_body(&jpeg(640, 400), "image/jpeg"))
                .await?;
            assert_eq!(status, StatusCode::OK, "{view}");
            let event = loop {
                let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                    .await??;
                if event.kind == "preview.thumbnail_updated" {
                    break event;
                }
            };
            // The private-conversation and private-runtime filters on /events
            // read these, as they do for `preview.wake`.
            assert_eq!(event.project_id, Some(f.project));
            assert_eq!(event.conversation_id, Some(f.conversation));
            assert_eq!(event.session_id, None);
            assert_eq!(event.data["runtimeId"], json!(job.runtime_id));
            assert_eq!(event.data["previewId"], json!(preview_id));
            assert_eq!(event.data["version"], view["version"]);
            Ok(())
        })
    })
    .await
}
