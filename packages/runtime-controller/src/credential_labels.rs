//! The names people give their AI connections (`user_credentials.label`).
//!
//! A connection's name is also the display name of the agent made for it, and
//! that agent's handle is made from it
//! (`ai_agents::create_default_agent_for_credential`). Teammates see both
//! wherever the agent takes part, so a name holds no email address, whoever
//! typed it. Every name a connection is saved or renamed with is a
//! [`CredentialLabel`], which only [`CredentialLabel::parse`] and the ChatGPT
//! defaults below make.

use std::collections::HashSet;

use axum::http::StatusCode;
use axum::Json;

use crate::ApiError;

/// The most characters a name has once trimmed.
pub(crate) const CREDENTIAL_LABEL_MAX_CHARS: usize = 60;

/// The 400 for a name that is empty, longer than 60 characters, or not one
/// line of plain text.
pub(crate) const CREDENTIAL_LABEL_INVALID_CODE: &str = "credential_label_invalid";
pub(crate) const CREDENTIAL_LABEL_INVALID_MESSAGE: &str =
    "Use a name of 1 to 60 characters on one line.";

/// The 400 for a name that holds an email address.
pub(crate) const CREDENTIAL_LABEL_HAS_EMAIL_CODE: &str = "credential_label_has_email";
pub(crate) const CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE: &str =
    "Leave the email address out of the name. Teammates see it on this connection's agent.";

/// What a ChatGPT device sign-in is called when nothing else names it.
const CHATGPT_SIGN_IN_LABEL: &str = "ChatGPT";

/// The at signs an address can be written with: `@` and its full-width and
/// small forms, which read the same.
const AT_SIGNS: [char; 3] = ['@', '\u{FF20}', '\u{FE6B}'];

/// The dots a domain can be written with: `.` and the full-width, halfwidth
/// ideographic and ideographic full stops, which internationalized domain
/// names read as dots.
const DOMAIN_DOTS: [char; 4] = ['.', '\u{FF0E}', '\u{FF61}', '\u{3002}'];

/// Characters an address's local part may have besides letters and digits.
const LOCAL_PART_PUNCTUATION: &str = "!#$%&'*+-/=?^_`{|}~.";

/// A name a connection may be saved with: trimmed, 1 to
/// [`CREDENTIAL_LABEL_MAX_CHARS`] characters on one line, without control,
/// line-break or text-direction characters, and without an email address.
#[derive(Debug)]
pub(crate) struct CredentialLabel(String);

impl CredentialLabel {
    /// `raw` trimmed, or the 400 that says why it is not a name.
    pub(crate) fn parse(raw: &str) -> Result<Self, (StatusCode, Json<ApiError>)> {
        let label = raw.trim();
        let length = label.chars().count();
        if length == 0
            || length > CREDENTIAL_LABEL_MAX_CHARS
            || label.chars().any(breaks_a_one_line_name)
        {
            return Err(label_refused(
                CREDENTIAL_LABEL_INVALID_CODE,
                CREDENTIAL_LABEL_INVALID_MESSAGE,
            ));
        }
        if holds_email_address(label) {
            return Err(label_refused(
                CREDENTIAL_LABEL_HAS_EMAIL_CODE,
                CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE,
            ));
        }
        Ok(Self(label.to_string()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

fn label_refused(code: &str, message: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            message: message.to_string(),
            code: Some(code.to_string()),
            details: None,
        }),
    )
}

/// Control characters, the Unicode line and paragraph separators, and the
/// marks that reorder text, which could make a name read as something else.
fn breaks_a_one_line_name(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{2028}'
                | '\u{2029}'
                | '\u{061C}'
                | '\u{200E}'
                | '\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
        )
}

/// Whether `text` holds an email address: an at sign with a character of an
/// address's local part right before it and a domain right after it. The
/// domain has two or more dot-separated parts, and its last part has two or
/// more characters, one of them a letter. "ann@example.com" and
/// "Work (ann.lee@corp.co.uk)" hold one; "@octo", "Work @ home", "team@home"
/// and "v1.5@2.0" do not.
pub(crate) fn holds_email_address(text: &str) -> bool {
    let characters: Vec<char> = text.chars().collect();
    characters.iter().enumerate().any(|(at, character)| {
        if !AT_SIGNS.contains(character) || at == 0 {
            return false;
        }
        let before = characters[at - 1];
        if !(before.is_alphanumeric() || LOCAL_PART_PUNCTUATION.contains(before)) {
            return false;
        }
        let domain: String = characters[at + 1..]
            .iter()
            .take_while(|character| {
                character.is_alphanumeric() || **character == '-' || DOMAIN_DOTS.contains(character)
            })
            .collect();
        is_email_domain(&domain)
    })
}

fn is_email_domain(domain: &str) -> bool {
    // A full stop that ends the sentence is not part of the address.
    let domain = domain.trim_end_matches(DOMAIN_DOTS);
    let parts: Vec<&str> = domain.split(DOMAIN_DOTS).collect();
    let Some(last) = parts.last() else {
        return false;
    };
    parts.len() >= 2
        && parts.iter().all(|part| !part.is_empty())
        && last.chars().count() >= 2
        && last.chars().any(char::is_alphabetic)
}

/// What a ChatGPT device sign-in that replaces none of the person's
/// connections is called: "ChatGPT" while none of `taken`, the names of their
/// live connections, is "ChatGPT" once case and surrounding space are
/// ignored, and otherwise "ChatGPT N" with the lowest N from 2 that none of
/// them is. A second sign-in of the same person therefore never shares the
/// first one's name.
pub(crate) fn numbered_chatgpt_label<'a>(
    taken: impl IntoIterator<Item = &'a str>,
) -> CredentialLabel {
    let taken: HashSet<String> = taken
        .into_iter()
        .map(|label| label.trim().to_lowercase())
        .collect();
    let base = CHATGPT_SIGN_IN_LABEL.to_lowercase();
    if !taken.contains(&base) {
        return CredentialLabel(CHATGPT_SIGN_IN_LABEL.to_string());
    }
    let mut number = 2_usize;
    while taken.contains(&format!("{base} {number}")) {
        number += 1;
    }
    CredentialLabel(format!("{CHATGPT_SIGN_IN_LABEL} {number}"))
}

/// What a ChatGPT device sign-in is called: the name of the live sign-in it
/// replaces, as that one is named when this one is saved and without a
/// number, so a reconnect keeps its name; otherwise the numbered default.
/// A replaced sign-in with no name, or with one saved before these rules that
/// they refuse, leaves the numbered default.
pub(crate) fn chatgpt_sign_in_label<'a>(
    replaced: Option<&str>,
    taken: impl IntoIterator<Item = &'a str>,
) -> CredentialLabel {
    replaced
        .and_then(|label| CredentialLabel::parse(label).ok())
        .unwrap_or_else(|| numbered_chatgpt_label(taken))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal_code(raw: &str) -> Option<String> {
        CredentialLabel::parse(raw)
            .err()
            .and_then(|(status, Json(error))| {
                assert_eq!(status, StatusCode::BAD_REQUEST, "{raw:?}");
                error.code
            })
    }

    fn parsed(raw: &str) -> Option<String> {
        CredentialLabel::parse(raw).ok().map(|label| label.0)
    }

    #[test]
    fn a_name_is_trimmed_and_one_line_of_at_most_sixty_characters() {
        assert_eq!(parsed("  Work ChatGPT  ").as_deref(), Some("Work ChatGPT"));
        // Sixty characters, counted as characters, not bytes.
        let sixty = "é".repeat(60);
        assert_eq!(parsed(&sixty), Some(sixty));
        // An emoji joined by zero-width joiners is a name like any other.
        assert_eq!(parsed("ChatGPT 👩‍💻").as_deref(), Some("ChatGPT 👩‍💻"));

        for raw in [
            "",
            "   ",
            &"a".repeat(61),
            "Work\nChatGPT",
            "Work\rChatGPT",
            "Work\tChatGPT",
            "Work\u{0}ChatGPT",
            "Work\u{85}ChatGPT",
            "Work\u{2028}ChatGPT",
            "Work\u{2029}ChatGPT",
            "\u{202E}TPGtahC",
            "ChatGPT\u{2066}",
        ] {
            assert_eq!(
                refusal_code(raw).as_deref(),
                Some(CREDENTIAL_LABEL_INVALID_CODE),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn a_name_holds_no_email_address() {
        for raw in [
            "ann@example.com",
            "ChatGPT (ann.lee@corp.co.uk)",
            "<ann+work@mail.example.io>",
            "mailto:ann@example.com",
            "Write to ann@example.com.",
            "ann\u{FF20}example.com",
            "ann@example\u{FF0E}com",
            "anna@例え.テスト",
        ] {
            assert!(holds_email_address(raw), "{raw:?}");
            assert_eq!(
                refusal_code(raw).as_deref(),
                Some(CREDENTIAL_LABEL_HAS_EMAIL_CODE),
                "{raw:?}"
            );
        }
        let Err((_, Json(error))) = CredentialLabel::parse("ann@example.com") else {
            panic!("an email address is refused");
        };
        assert_eq!(error.message, CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE);

        for raw in [
            "ChatGPT",
            "ChatGPT 2",
            "@octo's ChatGPT",
            "Work @ home",
            "team@home",
            "ann@",
            "@example.com",
            "v1.5@2.0",
            "z.ai",
            "Plan @ 5.30pm",
        ] {
            assert!(!holds_email_address(raw), "{raw:?}");
            assert_eq!(parsed(raw).as_deref(), Some(raw), "{raw:?}");
        }
    }

    #[test]
    fn a_second_chatgpt_sign_in_takes_the_lowest_free_number() {
        let name = |taken: &[&str]| numbered_chatgpt_label(taken.iter().copied()).0;
        assert_eq!(name(&[]), "ChatGPT");
        assert_eq!(name(&["Work", "OpenAI"]), "ChatGPT");
        // Only "ChatGPT" itself is a reason to number.
        assert_eq!(name(&["ChatGPT 2", "ChatGPT 3"]), "ChatGPT");
        assert_eq!(name(&["ChatGPT"]), "ChatGPT 2");
        // Case and surrounding space are ignored, for "ChatGPT" and its numbers.
        assert_eq!(name(&["  chatgpt "]), "ChatGPT 2");
        assert_eq!(name(&["ChatGPT", " CHATGPT 2", "ChatGPT 4"]), "ChatGPT 3");
        assert_eq!(name(&["ChatGPT", "ChatGPT 3"]), "ChatGPT 2");
        assert_eq!(name(&["ChatGPT", "ChatGPT 2", "ChatGPT 3"]), "ChatGPT 4");
    }

    #[test]
    fn a_reconnect_keeps_the_replaced_sign_in_s_name_without_a_number() {
        let name = |replaced: Option<&str>, taken: &[&str]| {
            chatgpt_sign_in_label(replaced, taken.iter().copied()).0
        };
        // The replaced sign-in is still live when its replacement is saved,
        // so numbering alone would call the reconnected "ChatGPT" "ChatGPT 2".
        assert_eq!(name(Some("ChatGPT"), &["ChatGPT"]), "ChatGPT");
        assert_eq!(
            name(Some("Work plan"), &["Work plan", "ChatGPT"]),
            "Work plan"
        );
        assert_eq!(
            name(Some("  ChatGPT 2 "), &["ChatGPT", "ChatGPT 2"]),
            "ChatGPT 2"
        );
        // Gone, unnamed, or named against the rules: the numbered default.
        assert_eq!(name(None, &["ChatGPT"]), "ChatGPT 2");
        assert_eq!(name(Some(""), &["ChatGPT"]), "ChatGPT 2");
        assert_eq!(
            name(Some("ann@example.com"), &["ann@example.com"]),
            "ChatGPT"
        );
    }
}
