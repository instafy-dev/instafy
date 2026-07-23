use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use crate::error::OriginError;

pub(super) const CLIENT_MESSAGE_MAX_BYTES: usize = 16 * 1024;
pub(super) const FRAME_DATA_MAX_BYTES: usize = 16 * 1024 * 1024;
pub(super) const VIEWPORT_MIN_WIDTH: u32 = 240;
pub(super) const VIEWPORT_MAX_WIDTH: u32 = 3840;
pub(super) const VIEWPORT_MIN_HEIGHT: u32 = 160;
pub(super) const VIEWPORT_MAX_HEIGHT: u32 = 2160;
pub(super) const VIEWPORT_MIN_DPR: f64 = 0.5;
pub(super) const VIEWPORT_MAX_DPR: f64 = 3.0;
pub(super) const VIEWPORT_MAX_DEVICE_PIXELS: f64 = 8_294_400.0;
const INPUT_COORDINATE_EPSILON: f64 = 1.0;
const INPUT_DELTA_MAX: f64 = 4096.0;
const INPUT_KEY_MAX_BYTES: usize = 128;
const INPUT_CODE_MAX_BYTES: usize = 128;
const INPUT_TEXT_MAX_BYTES: usize = 8 * 1024;
const INPUT_MODIFIERS_MAX: u8 = 15;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Viewport {
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
}

impl Viewport {
    pub fn new(width: u32, height: u32, dpr: f64) -> Result<Self, OriginError> {
        if !(VIEWPORT_MIN_WIDTH..=VIEWPORT_MAX_WIDTH).contains(&width) {
            return Err(OriginError::bad_request(format!(
                "screencast width must be between {VIEWPORT_MIN_WIDTH} and {VIEWPORT_MAX_WIDTH}"
            )));
        }
        if !(VIEWPORT_MIN_HEIGHT..=VIEWPORT_MAX_HEIGHT).contains(&height) {
            return Err(OriginError::bad_request(format!(
                "screencast height must be between {VIEWPORT_MIN_HEIGHT} and {VIEWPORT_MAX_HEIGHT}"
            )));
        }
        if !dpr.is_finite() || !(VIEWPORT_MIN_DPR..=VIEWPORT_MAX_DPR).contains(&dpr) {
            return Err(OriginError::bad_request(format!(
                "screencast dpr must be between {VIEWPORT_MIN_DPR} and {VIEWPORT_MAX_DPR}"
            )));
        }

        // A 2x stream is useful on dense displays, but an unconstrained DPR can
        // turn one authenticated viewer into a very large encoder allocation.
        // Preserve the logical viewport and reduce only DPR when the pixel cap
        // would otherwise be exceeded.
        let logical_pixels = f64::from(width) * f64::from(height);
        let pixel_capped_dpr = (VIEWPORT_MAX_DEVICE_PIXELS / logical_pixels).sqrt();
        let effective_dpr = dpr.min(pixel_capped_dpr).max(VIEWPORT_MIN_DPR);

        Ok(Self {
            width,
            height,
            dpr: effective_dpr,
        })
    }

    pub fn device_width(self) -> u32 {
        (f64::from(self.width) * self.dpr).round() as u32
    }

    pub fn device_height(self) -> u32 {
        (f64::from(self.height) * self.dpr).round() as u32
    }

    pub fn ready_message(self, message_type: &str) -> JsonValue {
        json!({
            "type": message_type,
            "width": self.width,
            "height": self.height,
            "dpr": self.dpr,
            "deviceWidth": self.device_width(),
            "deviceHeight": self.device_height(),
        })
    }

    pub fn device_metrics_params(self) -> JsonValue {
        json!({
            "width": self.width,
            "height": self.height,
            "deviceScaleFactor": self.dpr,
            "mobile": false,
            "screenWidth": self.width,
            "screenHeight": self.height,
            "screenOrientation": {
                "type": if self.width >= self.height { "landscapePrimary" } else { "portraitPrimary" },
                "angle": 0,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum MouseEventKind {
    MousePressed,
    MouseReleased,
    MouseMoved,
}

impl MouseEventKind {
    fn as_cdp_type(self) -> &'static str {
        match self {
            Self::MousePressed => "mousePressed",
            Self::MouseReleased => "mouseReleased",
            Self::MouseMoved => "mouseMoved",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum MouseButton {
    None,
    Left,
    Middle,
    Right,
    Back,
    Forward,
}

impl MouseButton {
    fn as_cdp_button(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Left => "left",
            Self::Middle => "middle",
            Self::Right => "right",
            Self::Back => "back",
            Self::Forward => "forward",
        }
    }
}

fn default_mouse_button() -> MouseButton {
    MouseButton::None
}

fn default_click_count() -> u8 {
    1
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum KeyEventKind {
    RawKeyDown,
    KeyDown,
    KeyUp,
    Char,
}

impl KeyEventKind {
    fn as_cdp_type(self) -> &'static str {
        match self {
            Self::RawKeyDown => "rawKeyDown",
            Self::KeyDown => "keyDown",
            Self::KeyUp => "keyUp",
            Self::Char => "char",
        }
    }
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum ClientMessage {
    Ack {
        #[serde(rename = "frameId")]
        frame_id: u64,
    },
    Resize {
        width: u32,
        height: u32,
        dpr: f64,
    },
    Mouse {
        kind: MouseEventKind,
        x: f64,
        y: f64,
        #[serde(default = "default_mouse_button")]
        button: MouseButton,
        #[serde(default)]
        modifiers: u8,
        #[serde(default)]
        buttons: u8,
        #[serde(default = "default_click_count", rename = "clickCount")]
        click_count: u8,
    },
    Wheel {
        x: f64,
        y: f64,
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
        #[serde(default)]
        modifiers: u8,
    },
    Key {
        kind: KeyEventKind,
        key: String,
        code: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        modifiers: u8,
        #[serde(default, rename = "autoRepeat")]
        auto_repeat: bool,
        #[serde(default, rename = "windowsVirtualKeyCode")]
        windows_virtual_key_code: Option<u32>,
        #[serde(default, rename = "nativeVirtualKeyCode")]
        native_virtual_key_code: Option<u32>,
    },
    Text {
        text: String,
    },
}

impl ClientMessage {
    pub fn parse(text: &str) -> Result<Self, OriginError> {
        if text.len() > CLIENT_MESSAGE_MAX_BYTES {
            return Err(OriginError::bad_request(
                "screencast input message is too large",
            ));
        }
        serde_json::from_str(text)
            .map_err(|_| OriginError::bad_request("invalid screencast input message"))
    }

    pub fn viewport(&self) -> Result<Option<Viewport>, OriginError> {
        match self {
            Self::Resize { width, height, dpr } => Viewport::new(*width, *height, *dpr).map(Some),
            _ => Ok(None),
        }
    }

    pub fn acknowledged_frame_id(&self) -> Option<u64> {
        match self {
            Self::Ack { frame_id } if *frame_id > 0 => Some(*frame_id),
            _ => None,
        }
    }

    pub fn to_cdp_command(
        &self,
        viewport: Viewport,
    ) -> Result<Option<(&'static str, JsonValue)>, OriginError> {
        match self {
            Self::Ack { frame_id } => {
                if *frame_id == 0 {
                    return Err(OriginError::bad_request(
                        "invalid screencast frame acknowledgement",
                    ));
                }
                // The browser client acknowledges the origin-generated frame
                // id. Only the screencast bridge knows which Chromium session
                // id belongs to that frame, so acknowledgements are handled
                // there rather than translated directly into a CDP command.
                Ok(None)
            }
            Self::Resize { .. } => Ok(Some((
                "Emulation.setDeviceMetricsOverride",
                self.viewport()?
                    .expect("resize has viewport")
                    .device_metrics_params(),
            ))),
            Self::Mouse {
                kind,
                x,
                y,
                button,
                modifiers,
                buttons,
                click_count,
            } => {
                validate_point(*x, *y, viewport)?;
                validate_modifiers(*modifiers)?;
                if *buttons > 31 {
                    return Err(OriginError::bad_request(
                        "mouse buttons are outside the allowed mask",
                    ));
                }
                if !(1..=3).contains(click_count) {
                    return Err(OriginError::bad_request(
                        "mouse clickCount must be between 1 and 3",
                    ));
                }
                Ok(Some((
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": kind.as_cdp_type(),
                        "x": x,
                        "y": y,
                        "button": button.as_cdp_button(),
                        "modifiers": modifiers,
                        "buttons": buttons,
                        "clickCount": click_count,
                        "pointerType": "mouse",
                    }),
                )))
            }
            Self::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                modifiers,
            } => {
                validate_point(*x, *y, viewport)?;
                validate_modifiers(*modifiers)?;
                if !delta_x.is_finite()
                    || !delta_y.is_finite()
                    || delta_x.abs() > INPUT_DELTA_MAX
                    || delta_y.abs() > INPUT_DELTA_MAX
                {
                    return Err(OriginError::bad_request(
                        "wheel delta is outside the allowed range",
                    ));
                }
                Ok(Some((
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mouseWheel",
                        "x": x,
                        "y": y,
                        "deltaX": delta_x,
                        "deltaY": delta_y,
                        "modifiers": modifiers,
                        "pointerType": "mouse",
                    }),
                )))
            }
            Self::Key {
                kind,
                key,
                code,
                text,
                modifiers,
                auto_repeat,
                windows_virtual_key_code,
                native_virtual_key_code,
            } => {
                validate_modifiers(*modifiers)?;
                validate_bounded_string("key", key, INPUT_KEY_MAX_BYTES, false)?;
                validate_bounded_string("code", code, INPUT_CODE_MAX_BYTES, true)?;
                validate_bounded_string("key text", text, INPUT_TEXT_MAX_BYTES, true)?;
                if matches!(kind, KeyEventKind::KeyUp | KeyEventKind::RawKeyDown)
                    && !text.is_empty()
                {
                    return Err(OriginError::bad_request(
                        "text is only allowed for keyDown or char events",
                    ));
                }
                if windows_virtual_key_code.is_some_and(|value| value > u16::MAX.into())
                    || native_virtual_key_code.is_some_and(|value| value > u16::MAX.into())
                {
                    return Err(OriginError::bad_request(
                        "virtual key code is outside the allowed range",
                    ));
                }
                let mut params = json!({
                    "type": kind.as_cdp_type(),
                    "key": key,
                    "code": code,
                    "modifiers": modifiers,
                    "autoRepeat": auto_repeat,
                });
                if !text.is_empty() {
                    params["text"] = JsonValue::String(text.clone());
                    params["unmodifiedText"] = JsonValue::String(text.clone());
                }
                if let Some(value) = windows_virtual_key_code {
                    params["windowsVirtualKeyCode"] = json!(value);
                }
                if let Some(value) = native_virtual_key_code {
                    params["nativeVirtualKeyCode"] = json!(value);
                }
                Ok(Some(("Input.dispatchKeyEvent", params)))
            }
            Self::Text { text } => {
                validate_bounded_string("text", text, INPUT_TEXT_MAX_BYTES, false)?;
                Ok(Some(("Input.insertText", json!({ "text": text }))))
            }
        }
    }
}

fn validate_point(x: f64, y: f64, viewport: Viewport) -> Result<(), OriginError> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x > f64::from(viewport.width) + INPUT_COORDINATE_EPSILON
        || y > f64::from(viewport.height) + INPUT_COORDINATE_EPSILON
    {
        return Err(OriginError::bad_request(
            "input coordinates are outside the screencast viewport",
        ));
    }
    Ok(())
}

fn validate_modifiers(modifiers: u8) -> Result<(), OriginError> {
    if modifiers > INPUT_MODIFIERS_MAX {
        return Err(OriginError::bad_request(
            "input modifiers are outside the allowed mask",
        ));
    }
    Ok(())
}

fn validate_bounded_string(
    label: &str,
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<(), OriginError> {
    if (!allow_empty && value.is_empty()) || value.len() > max_bytes {
        return Err(OriginError::bad_request(format!(
            "{label} must contain between {} and {max_bytes} bytes",
            usize::from(!allow_empty)
        )));
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(super) struct ScreencastFrame {
    pub session_id: i64,
    pub data: String,
    pub metadata: JsonValue,
}

pub(super) fn parse_screencast_frame(
    payload: &JsonValue,
) -> Result<Option<ScreencastFrame>, OriginError> {
    if payload.get("method").and_then(JsonValue::as_str) != Some("Page.screencastFrame") {
        return Ok(None);
    }
    let params = payload
        .get("params")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| OriginError::unavailable("invalid CDP screencast frame"))?;
    let session_id = params
        .get("sessionId")
        .and_then(JsonValue::as_i64)
        .filter(|value| *value >= 0)
        .ok_or_else(|| OriginError::unavailable("invalid CDP screencast frame session"))?;
    let data = params
        .get("data")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty() && value.len() <= FRAME_DATA_MAX_BYTES)
        .ok_or_else(|| OriginError::unavailable("CDP screencast frame exceeds the size limit"))?;
    let metadata = params
        .get("metadata")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(Some(ScreencastFrame {
        session_id,
        data: data.to_string(),
        metadata,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewport_preserves_logical_size_and_caps_device_pixels() {
        let retina = Viewport::new(1920, 1080, 2.0).expect("retina viewport");
        assert_eq!(retina.dpr, 2.0);
        assert_eq!(retina.device_width(), 3840);
        assert_eq!(retina.device_height(), 2160);

        let oversized = Viewport::new(2560, 1440, 2.0).expect("pixel-capped viewport");
        assert!(oversized.dpr < 2.0);
        assert!(
            f64::from(oversized.device_width()) * f64::from(oversized.device_height())
                <= VIEWPORT_MAX_DEVICE_PIXELS + 4096.0
        );
    }

    #[test]
    fn client_messages_are_strict_and_map_only_to_allowlisted_cdp_commands() {
        let viewport = Viewport::new(1280, 720, 2.0).expect("viewport");
        let mouse = ClientMessage::parse(
            r#"{"type":"mouse","kind":"mousePressed","x":40,"y":20,"button":"left","modifiers":2,"clickCount":1}"#,
        )
        .expect("mouse message");
        let (method, params) = mouse
            .to_cdp_command(viewport)
            .expect("valid mouse")
            .expect("command");
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["button"], "left");
        assert_eq!(params["modifiers"], 2);

        let ack =
            ClientMessage::parse(r#"{"type":"ack","frameId":9}"#).expect("frame acknowledgement");
        assert_eq!(ack.acknowledged_frame_id(), Some(9));
        assert_eq!(ack.to_cdp_command(viewport).expect("valid ack"), None);
        assert!(ClientMessage::parse(r#"{"type":"ack","sessionId":9}"#).is_err());

        assert!(
            ClientMessage::parse(r#"{"type":"Runtime.evaluate","expression":"secret"}"#).is_err()
        );
        assert!(ClientMessage::parse(
            r#"{"type":"mouse","kind":"mousePressed","x":40,"y":20,"button":"left","extra":"no"}"#,
        )
        .is_err());
    }

    #[test]
    fn input_bounds_reject_coordinates_deltas_and_text_abuse() {
        let viewport = Viewport::new(800, 600, 1.0).expect("viewport");
        let outside = ClientMessage::parse(
            r#"{"type":"mouse","kind":"mouseMoved","x":900,"y":20,"button":"none"}"#,
        )
        .expect("message parses");
        assert!(outside.to_cdp_command(viewport).is_err());

        let wheel =
            ClientMessage::parse(r#"{"type":"wheel","x":20,"y":20,"deltaX":0,"deltaY":9000}"#)
                .expect("wheel parses");
        assert!(wheel.to_cdp_command(viewport).is_err());

        let text = ClientMessage::Text {
            text: "x".repeat(INPUT_TEXT_MAX_BYTES + 1),
        };
        assert!(text.to_cdp_command(viewport).is_err());
    }

    #[test]
    fn frame_parser_bounds_payload_and_preserves_metadata() {
        let frame = parse_screencast_frame(&json!({
            "method": "Page.screencastFrame",
            "params": {
                "sessionId": 7,
                "data": "abcd",
                "metadata": { "deviceWidth": 1600, "deviceHeight": 900 }
            }
        }))
        .expect("frame parse")
        .expect("frame");
        assert_eq!(frame.session_id, 7);
        assert_eq!(frame.metadata["deviceWidth"], 1600);
        assert!(
            parse_screencast_frame(&json!({ "method": "Page.loadEventFired" }))
                .expect("other event")
                .is_none()
        );
    }
}
