//! The names people give their AI connections (`user_credentials.label`).
//!
//! A connection's name is also the display name of the agent made for it, and
//! that agent's handle is made from it
//! (`ai_agents::create_default_agent_for_credential`). Teammates see both
//! wherever the agent takes part, so the controller's routes save no name
//! that holds an email address, whoever typed it. Every name they save a
//! connection with or rename it to is a [`CredentialLabel`], which only
//! [`CredentialLabel::parse`] and the ChatGPT defaults below make.
//! `credential_label_fixtures.json` pins these rules, and Studio's copy
//! (`packages/frontend/src/utils/credentialLabelRules.ts`) is tested against
//! the same file, so Studio never sends a name the controller refuses.

use std::collections::HashSet;

use axum::http::StatusCode;
use axum::Json;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

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
/// small forms, which read the same. NFKC, which the email check reads names
/// in, makes the other two `@`.
const AT_SIGNS: [char; 3] = ['@', '\u{FF20}', '\u{FE6B}'];

/// The dots a domain can be written with: `.`; the full-width, halfwidth
/// ideographic and ideographic full stops, which internationalized domain
/// names read as dots; and the small full stop and the one-dot leader, which
/// read as one. NFKC makes all but the ideographic two `.`, and the halfwidth
/// ideographic one the ideographic one, so the set holds after it too.
const DOMAIN_DOTS: [char; 6] = [
    '.', '\u{FF0E}', '\u{FF61}', '\u{3002}', '\u{FE52}', '\u{2024}',
];

/// Characters an address's local part may have besides letters and digits.
const LOCAL_PART_PUNCTUATION: &str = "!#$%&'*+-/=?^_`{|}~.";

/// Unicode's Default_Ignorable_Code_Point set (DerivedCoreProperties.txt, as
/// of Unicode 17.0, the property Studio's copy reads from the browser):
/// characters that show nothing, such as the zero-width space, the word
/// joiner, the byte order mark, the soft hyphen, the Hangul fillers, the
/// text-direction marks and the tag characters.
const DEFAULT_IGNORABLE: &[(char, char)] = &[
    ('\u{00AD}', '\u{00AD}'),
    ('\u{034F}', '\u{034F}'),
    ('\u{061C}', '\u{061C}'),
    ('\u{115F}', '\u{1160}'),
    ('\u{17B4}', '\u{17B5}'),
    ('\u{180B}', '\u{180F}'),
    ('\u{200B}', '\u{200F}'),
    ('\u{202A}', '\u{202E}'),
    ('\u{2060}', '\u{206F}'),
    ('\u{3164}', '\u{3164}'),
    ('\u{FE00}', '\u{FE0F}'),
    ('\u{FEFF}', '\u{FEFF}'),
    ('\u{FFA0}', '\u{FFA0}'),
    ('\u{FFF0}', '\u{FFF8}'),
    ('\u{1BCA0}', '\u{1BCA3}'),
    ('\u{1D173}', '\u{1D17A}'),
    ('\u{E0000}', '\u{E0FFF}'),
];

/// A name a connection may be saved with: trimmed, 1 to
/// [`CREDENTIAL_LABEL_MAX_CHARS`] characters (code points) on one line,
/// without control, line-break, text-direction or other invisible characters,
/// and without an email address.
#[derive(Debug)]
pub(crate) struct CredentialLabel(String);

impl CredentialLabel {
    /// `raw` trimmed, or the 400 that says why it is not a name.
    pub(crate) fn parse(raw: &str) -> Result<Self, (StatusCode, Json<ApiError>)> {
        let label = raw.trim();
        let length = label.chars().count();
        if length == 0 || length > CREDENTIAL_LABEL_MAX_CHARS || breaks_a_one_line_name(label) {
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

/// Whether `label` holds a control character, a Unicode line or paragraph
/// separator, or a default-ignorable character a name does not keep: the
/// marks that reorder text and the ones that show nothing could make a name
/// read as something else, hide an email address from the check below, or be
/// a whole name that looks empty. The tag characters of a well-formed emoji
/// tag sequence, such as the flag of Scotland, are kept
/// ([`emoji_tag_sequence_end`]); any other tag character is refused.
fn breaks_a_one_line_name(label: &str) -> bool {
    let characters: Vec<char> = label.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        if let Some(end) = emoji_tag_sequence_end(&characters, index) {
            index = end;
            continue;
        }
        let character = characters[index];
        if character.is_control()
            || matches!(character, '\u{2028}' | '\u{2029}')
            || (is_default_ignorable(character) && !is_kept_in_names(character))
        {
            return true;
        }
        index += 1;
    }
    false
}

/// Where an emoji tag sequence that starts at `start` ends, past its last
/// character, when one does: the black flag U+1F3F4, one or more tag
/// characters U+E0020 to U+E007E, and the cancel tag U+E007F, as Unicode
/// writes the flags of England, Scotland and Wales.
fn emoji_tag_sequence_end(characters: &[char], start: usize) -> Option<usize> {
    if characters.get(start) != Some(&'\u{1F3F4}') {
        return None;
    }
    let mut index = start + 1;
    while matches!(characters.get(index), Some('\u{E0020}'..='\u{E007E}')) {
        index += 1;
    }
    (index > start + 1 && characters.get(index) == Some(&'\u{E007F}')).then_some(index + 1)
}

fn is_default_ignorable(character: char) -> bool {
    DEFAULT_IGNORABLE
        .iter()
        .any(|(first, last)| (*first..=*last).contains(&character))
}

/// The default-ignorable characters a name keeps, because scripts and emoji
/// need them: the zero-width non-joiner and joiner, and the variation
/// selectors (Unicode's Variation_Selector set, the Mongolian free ones
/// included).
fn is_kept_in_names(character: char) -> bool {
    matches!(
        character,
        '\u{200C}'
            | '\u{200D}'
            | '\u{180B}'..='\u{180D}'
            | '\u{180F}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

/// Whether `text` holds an email address: an at sign with a character of an
/// address's local part right before it and a domain right after it. The
/// domain has two or more dot-separated parts, and its last part has two or
/// more characters, one of them a letter. "ann@example.com" and
/// "Work (ann.lee@corp.co.uk)" hold one; "@octo", "Work @ home", "team@home"
/// and "v1.5@2.0" do not.
///
/// The text is read as a person sees it: in its NFKC form, so full-width and
/// other look-alike letters, at signs and dots count as the plain ones; without
/// its default-ignorable characters, so an invisible one the name keeps (a
/// joiner or a variation selector) does not split the address; and with each
/// combining mark taken as part of the letter it sits on.
pub(crate) fn holds_email_address(text: &str) -> bool {
    let characters: Vec<char> = text
        .nfkc()
        .filter(|character| !is_default_ignorable(*character))
        .collect();
    characters.iter().enumerate().any(|(at, character)| {
        if !AT_SIGNS.contains(character) {
            return false;
        }
        let Some(before) = characters[..at]
            .iter()
            .rev()
            .find(|character| !is_combining_mark(**character))
        else {
            return false;
        };
        if !(before.is_alphanumeric() || LOCAL_PART_PUNCTUATION.contains(*before)) {
            return false;
        }
        let domain: String = characters[at + 1..]
            .iter()
            .take_while(|character| is_domain_character(**character))
            .collect();
        is_email_domain(&domain)
    })
}

fn is_domain_character(character: char) -> bool {
    character.is_alphanumeric()
        || character == '-'
        || DOMAIN_DOTS.contains(&character)
        || is_combining_mark(character)
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

/// What a ChatGPT device sign-in is called: the name of the sign-in whose
/// place it takes (`device_auth::chatgpt_sign_in`), as that one is named when
/// this one is saved and without a number, so signing in again keeps the
/// name; otherwise the numbered default. A replaced sign-in with no name, or
/// with one saved before these rules that they refuse, leaves the numbered
/// default.
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

    /// The lists Studio's copy of these rules is tested against too.
    fn fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!("credential_label_fixtures.json")).expect("fixtures")
    }

    fn strings<'a>(fixtures: &'a serde_json::Value, key: &str) -> Vec<&'a str> {
        let items = fixtures[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixtures list {key}"));
        assert!(!items.is_empty(), "{key}");
        items
            .iter()
            .map(|item| item.as_str().expect("string"))
            .collect()
    }

    #[test]
    fn names_follow_the_fixtures() {
        let fixtures = fixtures();
        for name in strings(&fixtures, "valid") {
            assert_eq!(parsed(name).as_deref(), Some(name), "{name:?}");
        }
        for pair in fixtures["trimmed"].as_array().expect("trimmed") {
            let raw = pair[0].as_str().expect("name");
            let saved = pair[1].as_str().expect("saved");
            assert_eq!(parsed(raw).as_deref(), Some(saved), "{raw:?}");
        }
        for name in strings(&fixtures, "invalid") {
            assert_eq!(
                refusal_code(name).as_deref(),
                Some(CREDENTIAL_LABEL_INVALID_CODE),
                "{name:?}"
            );
        }
        for name in strings(&fixtures, "hasEmail") {
            assert!(holds_email_address(name), "{name:?}");
            assert_eq!(
                refusal_code(name).as_deref(),
                Some(CREDENTIAL_LABEL_HAS_EMAIL_CODE),
                "{name:?}"
            );
        }
        let Err((_, Json(error))) = CredentialLabel::parse("ann@example.com") else {
            panic!("an email address is refused");
        };
        assert_eq!(error.message, CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE);
    }

    #[test]
    fn a_name_is_at_most_sixty_code_points() {
        // Counted as characters, not bytes or UTF-16 units, so sixty emoji fit.
        for unit in ["a", "é", "😀"] {
            assert!(parsed(&unit.repeat(60)).is_some(), "{unit}");
            assert_eq!(
                refusal_code(&unit.repeat(61)).as_deref(),
                Some(CREDENTIAL_LABEL_INVALID_CODE),
                "{unit}"
            );
        }
    }

    #[test]
    fn invisible_characters_and_look_alikes_hide_no_email_address() {
        // A name of one invisible character looks empty.
        assert_eq!(
            refusal_code("\u{200B}").as_deref(),
            Some(CREDENTIAL_LABEL_INVALID_CODE)
        );
        // An invisible character in an address no longer splits it from the
        // check: it is refused itself.
        for raw in [
            "ann\u{200B}@example.com",
            "ann@\u{200B}example.com",
            "ann\u{00AD}@example.com",
            "ann\u{FEFF}@example.com",
            "ann\u{2060}@example.com",
            "ann@example.com\u{E0001}",
        ] {
            assert_eq!(
                refusal_code(raw).as_deref(),
                Some(CREDENTIAL_LABEL_INVALID_CODE),
                "{raw:?}"
            );
        }
        // A combining mark, or a dot NFKC reads as `.`, leaves the address one.
        for raw in [
            "anne\u{0301}@example.com",
            "ann\u{0359}@example.com",
            "ann@example\u{FE52}com",
            "ann@example\u{2024}com",
            // The invisible characters a name keeps do not split it either.
            "ann\u{200D}@example.com",
            "ann@exa\u{200C}mple.com",
        ] {
            assert_eq!(
                refusal_code(raw).as_deref(),
                Some(CREDENTIAL_LABEL_HAS_EMAIL_CODE),
                "{raw:?}"
            );
        }
        // Names that need those characters still pass: emoji sequences joined
        // by ZWJ or styled by a variation selector, and words written with ZWNJ.
        for raw in [
            "ChatGPT 👩\u{200D}💻",
            "\u{2764}\u{FE0F} plan",
            "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
        ] {
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
