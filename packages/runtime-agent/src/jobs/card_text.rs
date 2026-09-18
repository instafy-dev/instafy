//! Pack-authored card text, cleaned before it is ever persisted.
//!
//! A SKILL.md is untrusted content fetched from a public repository at run
//! time, and its words now render inside the product's UI next to an input.
//! This module is the first of two identical gates: it runs here so the
//! persisted `details` are already clean for every client, including the ones
//! that cannot be patched from a web deploy. The second gate is
//! `packages/frontend/src/screens/studio/components/packCardText.ts`, which
//! runs on read because messages persisted by an older runtime exist forever.
//! Both are pinned to the same fixture list in `card_text_fixtures.json`, so
//! they cannot drift.
//!
//! The rules reject rather than repair. A half-sentence that a pack composed
//! on purpose is more dangerous than no sentence: the card has its own wording
//! for every absence, and an absence cannot be made to say anything.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// A heading, so it is rejected rather than cut: a phrase clipped mid-word
/// reads as a bug the person will blame on us.
pub const MAX_VALUE_LABEL_CHARS: usize = 48;
pub const MAX_VALUE_LABEL_WORDS: usize = 6;
/// One plain sentence saying what the value lets Instafy do.
pub const MAX_DESCRIPTION_CHARS: usize = 200;
/// One plain sentence naming the screen the value is found on. Rejected rather
/// than cut, for the reason spelled out where the cap is applied.
pub const MAX_WHERE_TO_GET_CHARS: usize = 160;

/// Which of the three pack-derived strings is being cleaned. The field decides
/// the cap and whether an over-length string is cut or refused; every other
/// rule is the same for all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardTextField {
    ValueLabel,
    Description,
    WhereToGet,
}

impl CardTextField {
    fn cap(self) -> usize {
        match self {
            CardTextField::ValueLabel => MAX_VALUE_LABEL_CHARS,
            CardTextField::Description => MAX_DESCRIPTION_CHARS,
            CardTextField::WhereToGet => MAX_WHERE_TO_GET_CHARS,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CardTextField::ValueLabel => "valueLabel",
            CardTextField::Description => "description",
            CardTextField::WhereToGet => "whereToGet",
        }
    }
}

/// The curated identity names. A pack may name the product its own card already
/// resolves to, and nothing else: a description that says "Notion" on a card
/// wearing Slack's mark, or that says "Google" on any card at all, is an
/// attempt to borrow an identity the catalogue did not grant. The last four are
/// not connectors; they are the sign-in brands a hostile pack would reach for,
/// so they are never anyone's own name and always reject.
const IDENTITY_PRODUCT_NAMES: &[&str] = &[
    "slack",
    "notion",
    "github",
    "discord",
    "freefinance",
    "google",
    "apple",
    "microsoft",
    "facebook",
];

/// Identity only, mirroring the `secretNames` and `skillName` of
/// `packages/frontend/src/screens/studio/components/connectors.ts`. It carries
/// no customer-facing copy: a product name and the variable names its setup
/// asks for, which is exactly the half of the old catalogue entry a pack must
/// never be able to write.
pub const CONNECTOR_IDENTITIES: &[(&str, &str, &[&str])] = &[
    ("Slack", "slack", &["SLACK_BOT_TOKEN"]),
    ("Notion", "notion", &["NOTION_API_KEY"]),
    ("Discord", "discord", &["DISCORD_BOT_TOKEN"]),
    (
        "FreeFinance",
        "freefinance",
        &[
            "FREEFINANCE_API_CLIENT_ID",
            "FREEFINANCE_API_CLIENT_SECRET",
            "FREEFINANCE_CLIENT_ID",
            "FREEFINANCE_API_BASE_URL",
        ],
    ),
];

/// Our own name. A pack may say what the value lets Instafy do, because that is
/// the sentence the prompt asks it for, but it may never put our name in the
/// card's heading and it may never speak as us: the card is already our
/// surface, so "Instafy verification code" over a real input is first-party
/// chrome a pack did not earn.
const OWN_PRODUCT_NAME: &str = "instafy";
const FIRST_PARTY_AUTHORITY_PHRASES: &[&str] = &[
    "instafy support",
    "instafy security",
    "instafy team",
    "instafy staff",
    "instafy admin",
    "instafy will never",
];

/// Claims about what happens to the value. The card says where the value is
/// kept, in our words, one line below whatever the pack wrote; a second claim
/// beside it can only weaken or contradict the first, and the worst of them
/// ("reply in the chat with your login") instructs the person to do the exact
/// thing our caption promises never happens. The prompt already forbids all of
/// this; this is the half that is enforced rather than asked for.
const HANDLING_CLAIM_TERMS: &[&str] = &[
    "stored",
    "store",
    "saved",
    "kept",
    "encrypted",
    "deleted",
    "secure",
    "safe",
    "sent to",
    "shared with",
    "in the chat",
    "in this chat",
    "reply with",
    "paste it in the chat",
];

/// The values Instafy will not take from anyone, in our words rather than the
/// pack's. A word here rejects the string that contains it, and a variable name
/// built from one refuses the whole request.
const HUMAN_CREDENTIAL_TERMS: &[&str] = &[
    "password",
    "passwords",
    "passphrase",
    "passphrases",
    "passcode",
    "passcodes",
    "pin",
    "pins",
    "cvv",
    "cvc",
    "card number",
    "credit card",
    "debit card",
    "recovery phrase",
    "seed phrase",
    "mnemonic",
    "social security",
    "ssn",
];

/// The refusal classes, named from this fixed table and never from the pack's
/// own words. Each entry is (class as the card prints it, the name fragments
/// that select it).
const REFUSED_CLASSES: &[(&str, &[&str])] = &[
    ("password", &["password", "passwd", "pwd"]),
    ("passphrase", &["passphrase"]),
    ("PIN", &["pin"]),
    ("card number", &["cardnumber", "ccnumber", "cvv", "cvc"]),
    (
        "recovery phrase",
        &["mnemonic", "seedphrase", "recoveryphrase"],
    ),
];

/// True when the name is one we understand well enough to write to. It is the
/// destination key, so it is validated and never cleaned: a name that needs
/// repairing is a name we do not understand, and guessing at a destination is
/// the one failure this card cannot have.
pub fn validate_secret_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 128 {
        return false;
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap_or('\0');
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// The class of human login credential this variable name asks for, if any. A
/// hit drops the request before any card can render it: the product does not
/// take these values, whatever a pack says it will do with them.
pub fn refused_secret_class(name: &str) -> Option<&'static str> {
    let squashed: String = name
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    let tokens: Vec<String> = name
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect();
    for (class, fragments) in REFUSED_CLASSES {
        for fragment in *fragments {
            // "pin" is a whole word: PIN_CODE is refused, PINNED_REPO is not.
            let matched = if *fragment == "pin" {
                tokens.iter().any(|token| token == "pin")
            } else {
                squashed.contains(fragment)
            };
            if matched {
                return Some(class);
            }
        }
    }
    if tokens.windows(2).any(|pair| pair == ["card", "number"]) {
        return Some("card number");
    }
    if tokens
        .windows(2)
        .any(|pair| pair == ["recovery", "phrase"] || pair == ["seed", "phrase"])
    {
        return Some("recovery phrase");
    }
    None
}

/// The connector this request resolves to, by the same rule the card uses: the
/// variable name must be one the entry declares, and a declared skill slug must
/// be that entry's own. Both must agree, so a pack cannot wear Notion's name by
/// claiming `skill: "notion"` alone.
pub fn resolve_connector_name(secret_name: &str, skill_slug: Option<&str>) -> Option<&'static str> {
    let needle = secret_name.trim().to_ascii_uppercase();
    if needle.is_empty() {
        return None;
    }
    let slug = skill_slug.map(|value| value.trim().to_ascii_lowercase());
    for (name, skill, secrets) in CONNECTOR_IDENTITIES {
        if !secrets
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(&needle))
        {
            continue;
        }
        if let Some(slug) = slug.as_deref() {
            if !slug.is_empty() && slug != *skill {
                return None;
            }
        }
        return Some(name);
    }
    None
}

/// The folder name under `.agents/skills` of the skill that asked, reduced to
/// what a folder name may be. Provenance, never a display name.
pub fn sanitize_skill_slug(value: &str) -> Option<String> {
    let slug: String = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '-')
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() || slug.chars().count() > 64 {
        None
    } else {
        Some(slug)
    }
}

fn is_stripped(ch: char) -> bool {
    matches!(ch,
        // Bidi overrides and isolates: they let the visible order differ from
        // the stored order, so a cap measured on the stored string is not the
        // string the person reads.
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        // Zero width, which pads a string past a cap without showing anything.
        | '\u{200B}'..='\u{200D}' | '\u{FEFF}'
    )
        // Every C0 and C1 control that is not a space of some kind. Tab,
        // newline and carriage return are left for the collapse below, which
        // turns them into one space rather than closing the words up against
        // each other.
        || ((ch.is_control() || matches!(ch, '\u{0080}'..='\u{009F}')) && !ch.is_whitespace())
}

/// Punctuation for the repetition rule: anything that is neither a letter, a
/// digit nor a space. Box drawing and block characters are not punctuation to
/// Unicode, but a run of them is how a pack draws its own fake banner, which is
/// the thing this rule exists to stop.
fn is_rule_punctuation(ch: char) -> bool {
    !ch.is_alphanumeric() && !ch.is_whitespace()
}

/// One ASCII letter for a character that is drawn like one. A name rule that
/// compares literal ASCII is a name rule a pack walks past by spelling Apple
/// with a Cyrillic А, so every term test runs against this skeleton while the
/// card renders the original: match on the skeleton, show the string.
fn fold_confusable(ch: char) -> char {
    match ch {
        // Cyrillic
        '\u{0430}' | '\u{0410}' => 'a',
        '\u{0435}' | '\u{0415}' => 'e',
        '\u{043E}' | '\u{041E}' => 'o',
        '\u{0440}' | '\u{0420}' => 'p',
        '\u{0441}' | '\u{0421}' => 'c',
        '\u{0445}' | '\u{0425}' => 'x',
        '\u{0443}' | '\u{0423}' => 'y',
        '\u{0456}' | '\u{0406}' => 'i',
        '\u{0455}' | '\u{0405}' => 's',
        '\u{0458}' | '\u{0408}' => 'j',
        '\u{043A}' | '\u{041A}' => 'k',
        '\u{043C}' | '\u{041C}' => 'm',
        '\u{0442}' | '\u{0422}' => 't',
        '\u{0432}' | '\u{0412}' => 'b',
        '\u{043D}' | '\u{041D}' => 'h',
        '\u{0433}' => 'r',
        // Greek
        '\u{03BF}' | '\u{039F}' => 'o',
        '\u{03BD}' | '\u{039D}' => 'n',
        '\u{03B1}' | '\u{0391}' => 'a',
        '\u{03C1}' | '\u{03A1}' => 'p',
        '\u{03B5}' | '\u{0395}' => 'e',
        '\u{03B9}' | '\u{0399}' => 'i',
        '\u{03BA}' | '\u{039A}' => 'k',
        '\u{03C4}' | '\u{03A4}' => 't',
        '\u{03C5}' | '\u{03A5}' => 'y',
        '\u{03C7}' | '\u{03A7}' => 'x',
        '\u{039C}' => 'm',
        '\u{0392}' => 'b',
        '\u{0397}' => 'h',
        '\u{0396}' => 'z',
        // Dotless Latin and its neighbours
        '\u{0131}' => 'i',
        '\u{0237}' => 'j',
        _ => ch,
    }
}

/// The string every term rule reads. NFKD folds the fullwidth and the
/// decorated forms (so `paｓsword` is a password), the marks come off (so a
/// zalgo run is still the word underneath), the confusable letters become
/// their ASCII twins, and the whole thing lowercases.
fn skeleton(text: &str) -> String {
    text.nfkd()
        .filter(|ch| !is_combining_mark(*ch))
        .map(fold_confusable)
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

/// At most two combining marks on one base. One or two is an accent; a run of
/// forty is a pack drawing a column of its own down our card, and each one
/// costs it a single character against the cap.
fn limit_combining_marks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut marks = 0usize;
    for ch in text.chars() {
        if is_combining_mark(ch) {
            if marks >= 2 {
                continue;
            }
            marks += 1;
        } else {
            marks = 0;
        }
        out.push(ch);
    }
    out
}

/// A host name written without its scheme. The link rule was scheme-only, so
/// dropping four characters from the spec's own example walked a domain onto
/// the card, under the connector's mark. A trailing sentence full stop is
/// legal because it is taken off before the last label is read.
fn looks_like_host(token: &str) -> bool {
    let trimmed = token.trim_end_matches(|ch| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?'));
    let host = match trimmed.find(['/', '?', '#']) {
        Some(index) => &trimmed[..index],
        None => trimmed,
    };
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    if labels.iter().any(|label| {
        label.is_empty()
            || !label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    }) {
        return false;
    }
    let last = labels[labels.len() - 1];
    last.chars().count() >= 2 && last.chars().all(|ch| ch.is_ascii_alphabetic())
}

/// Markup, a link or a bare host: three of the things `rejects` refuses
/// outright rather than repairing.
///
/// `skill_declaration` reads this to choose a clean clause out of a pack's
/// sentence *before* anything is sanitized, so "the token, starting with
/// `ntn_`" can be cut at its comma instead of costing the whole sentence. It is
/// deliberately a test and not a cleaner: nothing here removes a backtick from
/// a string and hands the result on as clean, because a stripped string that
/// passes the gate is the gate not working.
pub fn carries_markup_or_link(text: &str) -> bool {
    if text.contains('`') || text.contains("](") || text.contains('<') {
        return true;
    }
    let lower = text.to_lowercase();
    if lower.contains("http://") || lower.contains("https://") || lower.contains("www.") {
        return true;
    }
    lower.split_whitespace().any(looks_like_host)
}

/// Box drawing, block elements and geometric shapes. No honest sentence about
/// a provider's screen needs one, and every one of them is a brick in a banner
/// the pack is drawing for itself.
fn is_drawing_character(ch: char) -> bool {
    matches!(ch, '\u{2500}'..='\u{25FF}' | '\u{2B00}'..='\u{2BFF}')
}

fn contains_term(haystack: &str, term: &str) -> bool {
    let bytes = haystack.as_bytes();
    let needle = term.as_bytes();
    if needle.is_empty() || needle.len() > bytes.len() {
        return false;
    }
    for start in 0..=(bytes.len() - needle.len()) {
        if &bytes[start..start + needle.len()] != needle {
            continue;
        }
        let before_ok = start == 0 || !(bytes[start - 1] as char).is_ascii_alphanumeric();
        let end = start + needle.len();
        let after_ok = end == bytes.len() || !(bytes[end] as char).is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// The one product name this string may contain. The resolved connector's name
/// when the catalogue claimed the request; otherwise the product the asking
/// skill's own folder name is built from, so a pack declaring
/// `skill: "google-calendar"` may write "Google" while a card wearing Notion's
/// mark still may not. A resolved owner always wins, so the section 7 attacker,
/// who resolves to Notion, cannot buy "Google" with a slug.
fn allowed_identity(owner: Option<&str>, skill_slug: Option<&str>) -> Option<String> {
    if let Some(owner) = owner {
        return Some(owner.to_ascii_lowercase());
    }
    let slug = skill_slug?.trim().to_ascii_lowercase();
    if slug.is_empty() {
        return None;
    }
    IDENTITY_PRODUCT_NAMES
        .iter()
        .find(|product| slug.split('-').any(|part| part == **product))
        .map(|product| (*product).to_string())
}

fn rejects(text: &str, allowed: Option<&str>, field: CardTextField) -> bool {
    // Markup, a Markdown link, code formatting, a link of any kind, and the
    // em dash the house style forbids. The file-level gate cannot reach text
    // that arrives at run time, so the rule lives here too.
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '<' {
            if let Some(next) = chars.peek() {
                if !next.is_whitespace() {
                    return true;
                }
            }
        }
    }
    if text.contains("](") || text.contains('`') || text.contains('\u{2014}') {
        return true;
    }
    let lower = text.to_lowercase();
    if lower.contains("http://") || lower.contains("https://") || lower.contains("www.") {
        return true;
    }
    // A host with the scheme dropped is still a place to be sent.
    if lower.split_whitespace().any(looks_like_host) {
        return true;
    }

    // Three or more of the same punctuation character in a row: a horizontal
    // rule, a box, or any other attempt to draw chrome we did not draw.
    let mut run_char: Option<char> = None;
    let mut run_len = 0usize;
    for ch in text.chars() {
        if is_rule_punctuation(ch) && run_char == Some(ch) {
            run_len += 1;
            if run_len >= 3 {
                return true;
            }
        } else {
            run_char = if is_rule_punctuation(ch) {
                Some(ch)
            } else {
                None
            };
            run_len = 1;
        }
    }
    // The same banner with a space or an alternation in it: `▄ ▄ ▄ SECURITY`
    // and `-=-=-=-=` defeat a run rule and nothing else about them is honest.
    // One drawing character is enough, and rule punctuation over a quarter of
    // the string is a drawing whatever glyphs it used.
    if text.chars().any(is_drawing_character) {
        return true;
    }
    let dense: usize = text.chars().filter(|ch| !ch.is_whitespace()).count();
    let punctuation = text.chars().filter(|ch| is_rule_punctuation(*ch)).count();
    if punctuation * 4 > dense {
        return true;
    }

    // Everything below reads the skeleton, so a confusable letter cannot buy a
    // pack a word our table holds.
    let skeleton = skeleton(&lower);
    let mut runs = 0usize;
    for ch in skeleton.chars() {
        if ch.is_whitespace() {
            runs = 0;
            continue;
        }
        runs += 1;
        // No word a person reads is this long, and an unbreakable one pushes
        // the card past the column it lives in whatever the cap says.
        if runs > 30 {
            return true;
        }
    }

    if HUMAN_CREDENTIAL_TERMS
        .iter()
        .any(|term| contains_term(&skeleton, term))
    {
        return true;
    }

    if HANDLING_CLAIM_TERMS
        .iter()
        .any(|term| contains_term(&skeleton, term))
    {
        return true;
    }

    if FIRST_PARTY_AUTHORITY_PHRASES
        .iter()
        .any(|phrase| contains_term(&skeleton, phrase))
    {
        return true;
    }
    // Our own name is never a heading a pack writes. It stays legal in a
    // sentence, because "what this value lets Instafy do" is the sentence the
    // prompt asks the pack for.
    if field == CardTextField::ValueLabel && contains_term(&skeleton, OWN_PRODUCT_NAME) {
        return true;
    }

    let own = allowed.map(str::to_ascii_lowercase);
    IDENTITY_PRODUCT_NAMES.iter().any(|product| {
        if own.as_deref() == Some(*product) {
            return false;
        }
        contains_term(&skeleton, product)
    })
}

/// The owner's own name, off the front of a heading the card is about to put
/// that name in front of. "Notion Installation access token" is a heading a
/// pack derives honestly from a "What it is" cell, and rendering it whole
/// makes the card's largest text read "Notion Notion Installation access
/// token".
fn strip_leading_owner(text: &str, owner: Option<&str>) -> String {
    let Some(owner) = owner else {
        return text.to_string();
    };
    let owner = owner.trim();
    if owner.is_empty() {
        return text.to_string();
    }
    let head: String = text.chars().take(owner.chars().count()).collect();
    if !head.eq_ignore_ascii_case(owner) {
        return text.to_string();
    }
    let rest: String = text.chars().skip(owner.chars().count()).collect();
    match rest.chars().next() {
        Some(ch) if ch.is_whitespace() => rest.trim_start().to_string(),
        // The heading was the owner's name and nothing else, so it is an
        // absence: the card says "Connect Notion" rather than "Notion Notion".
        None => String::new(),
        _ => text.to_string(),
    }
}

fn truncate_at_word(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let head: Vec<char> = text.chars().take(cap.saturating_sub(1)).collect();
    // Both gates count characters here. Comparing a byte offset against a
    // character cap cut a Cyrillic sentence in a different place from the
    // frontend's, which is drift in the one thing the shared fixtures exist to
    // prevent.
    let cut: String = match head.iter().rposition(|ch| *ch == ' ') {
        Some(index) if index >= cap / 2 => head[..index].iter().collect(),
        _ => head.iter().collect(),
    };
    let trimmed = cut.trim_end_matches(|ch: char| ch.is_whitespace() || is_rule_punctuation(ch));
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\u{2026}")
    }
}

/// One pack-authored string, ready to be put in a DOM node, or nothing.
///
/// `owner` is the resolved connector's product name, which is the one product
/// name this string may contain. When nothing resolved, `skill_slug` stands in
/// for it: a pack whose folder is `google-calendar` may write "Google", which
/// is the generic path this change exists to serve, while a card that resolved
/// to Notion may still write only "Notion". Pass both as `None` and every
/// catalogue name rejects.
pub fn sanitize_card_text(
    value: &str,
    field: CardTextField,
    owner: Option<&str>,
    skill_slug: Option<&str>,
) -> Option<String> {
    let normalized: String = value.nfc().collect();
    let stripped: String = normalized.chars().filter(|ch| !is_stripped(*ch)).collect();
    let stripped = limit_combining_marks(&stripped);
    let collapsed = stripped.split_whitespace().collect::<Vec<&str>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let allowed = allowed_identity(owner, skill_slug);
    if rejects(&collapsed, allowed.as_deref(), field) {
        return None;
    }

    // Whether an over-length string is cut or refused is a property of what the
    // string is for. A description is prose that makes its point in its first
    // clause, so a cut one still reads. The other two are directives whose
    // point is the last noun: "open the connection's Configuration tab", cut,
    // becomes "on its Configuration" and an ellipsis, which names no screen at
    // all and sends the person looking for something that is not there. Those
    // are refused, and the pack's own table answers in their place.
    let capped = match field {
        CardTextField::Description => truncate_at_word(&collapsed, field.cap()),
        CardTextField::WhereToGet => {
            if collapsed.chars().count() > field.cap() {
                return None;
            }
            collapsed
        }
        CardTextField::ValueLabel => {
            // The card puts the product name in front of this heading, so the
            // pack's own copy of it comes off before anything is measured.
            let collapsed = strip_leading_owner(&collapsed, owner);
            if collapsed.is_empty() {
                return None;
            }
            if collapsed.chars().count() > field.cap() {
                return None;
            }
            // A heading, so a trailing full stop is dropped rather than shown:
            // the card puts the product name in front of it and never a
            // sentence after.
            let trimmed = collapsed
                .trim_end_matches(['.', '!', '?'])
                .trim()
                .to_string();
            if trimmed.split(' ').filter(|word| !word.is_empty()).count() > MAX_VALUE_LABEL_WORDS {
                return None;
            }
            trimmed
        }
    };

    if capped.is_empty() {
        None
    } else {
        Some(capped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as JsonValue;

    fn field_from(name: &str) -> CardTextField {
        match name {
            "valueLabel" => CardTextField::ValueLabel,
            "whereToGet" => CardTextField::WhereToGet,
            _ => CardTextField::Description,
        }
    }

    fn fixtures() -> JsonValue {
        let raw = include_str!("card_text_fixtures.json");
        serde_json::from_str(raw).expect("fixtures parse")
    }

    #[test]
    fn shared_fixtures_agree_with_the_frontend_gate() {
        // The same list the frontend's packCardText test reads. A rule changed
        // on one side and not the other fails here first.
        let parsed = fixtures();
        let cases = parsed["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 20, "fixtures got thin: {}", cases.len());
        for case in cases {
            let input = case["input"].as_str().expect("input");
            let field = field_from(case["field"].as_str().unwrap_or("description"));
            let owner = case["owner"].as_str();
            let skill = case["skill"].as_str();
            let expected = case["expected"].as_str();
            let actual = sanitize_card_text(input, field, owner, skill);
            assert_eq!(
                actual.as_deref(),
                expected,
                "fixture {:?} ({})",
                case["name"],
                field.as_str()
            );
        }
    }

    #[test]
    fn shared_fixtures_pin_the_refused_names() {
        // The refusal is the one rule both gates have to agree on without a
        // message to compare: the runtime refuses on the way in, and the card
        // refuses again on the way out for everything an older runtime wrote.
        let parsed = fixtures();
        let names = parsed["names"].as_array().expect("names array");
        assert!(names.len() >= 6, "name fixtures got thin: {}", names.len());
        for case in names {
            let name = case["name"].as_str().expect("name");
            let expected = case["refusedClass"].as_str();
            assert_eq!(
                refused_secret_class(name),
                expected,
                "refusal fixture {name:?}"
            );
        }
    }

    #[test]
    fn shared_fixtures_pin_the_identity_table() {
        // This table is a hand copy of the frontend catalogue, and the drift it
        // can suffer is silent: a connector added there and forgotten here
        // resolves to no owner, so the pack's honest sentence naming its own
        // product is rejected and the card renders without it. connectors.ts
        // asserts the same array from the other side.
        let parsed = fixtures();
        let identities = parsed["identities"].as_array().expect("identities array");
        let expected: Vec<(String, String, Vec<String>)> = identities
            .iter()
            .map(|entry| {
                (
                    entry["name"].as_str().expect("name").to_string(),
                    entry["skillName"].as_str().expect("skillName").to_string(),
                    entry["secretNames"]
                        .as_array()
                        .expect("secretNames")
                        .iter()
                        .map(|value| value.as_str().expect("secret name").to_string())
                        .collect(),
                )
            })
            .collect();
        let actual: Vec<(String, String, Vec<String>)> = CONNECTOR_IDENTITIES
            .iter()
            .map(|(name, skill, secrets)| {
                (
                    (*name).to_string(),
                    (*skill).to_string(),
                    secrets.iter().map(|value| (*value).to_string()).collect(),
                )
            })
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_the_hostile_pack_whole_rather_than_repairing_it() {
        // The em dash the file-level copy gate cannot reach, a link, a bidi
        // override and a rule of box-drawing characters: each on its own is a
        // rejection, and a rejection is the whole string.
        assert_eq!(
            sanitize_card_text(
                "Reads your pages \u{2014} and writes them",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Sign in at https://notion-security-check.example to confirm.",
                CardTextField::WhereToGet,
                Some("Notion"),
                None,
            ),
            None
        );
        // The same sentence with the scheme dropped, which is all the attacker
        // had to do to the spec's own example.
        assert_eq!(
            sanitize_card_text(
                "Open notion-security-check.example, sign in, and copy the code it shows you.",
                CardTextField::WhereToGet,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "\u{202E}Your token was leaked\u{202C}",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            Some("Your token was leaked".to_string()),
        );
        assert_eq!(
            sanitize_card_text(
                "\u{2500}\u{2500}\u{2500}\u{2500} SECURITY CHECK \u{2500}\u{2500}\u{2500}\u{2500}",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            None
        );
        // The same banner with a space between the glyphs, which the run rule
        // alone did not see.
        assert_eq!(
            sanitize_card_text(
                "\u{2584} \u{2584} \u{2584} SECURITY ALERT \u{2584} \u{2584} \u{2584} Your token was leaked.",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "-=-=-=-= ACTION REQUIRED -=-=-=-= Copy the code from the alert email.",
                CardTextField::WhereToGet,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Account password <img src=x onerror=alert(1)>",
                CardTextField::ValueLabel,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Account password",
                CardTextField::ValueLabel,
                Some("Notion"),
                None,
            ),
            None
        );
        // A Cyrillic А is an A to anybody reading the card, so it is one to the
        // rules as well.
        assert_eq!(
            sanitize_card_text(
                "\u{0410}pple ID access key",
                CardTextField::ValueLabel,
                None,
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Account pa\u{FF53}sword",
                CardTextField::ValueLabel,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Sign in with your Google account.",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            None
        );
        // A claim about what happens to the value, one line above the card's
        // own sentence saying what actually happens to it.
        assert_eq!(
            sanitize_card_text(
                "This value is never stored and is sent straight to the provider to verify you.",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Reply in the chat with your login and we will fetch the code for you.",
                CardTextField::WhereToGet,
                Some("Notion"),
                None,
            ),
            None
        );
        // Our own name is the most valuable one on our own surface.
        assert_eq!(
            sanitize_card_text(
                "Instafy verification code",
                CardTextField::ValueLabel,
                None,
                None,
            ),
            None
        );
        assert_eq!(
            sanitize_card_text(
                "Instafy support needs this code to keep your space open.",
                CardTextField::Description,
                None,
                None,
            ),
            None
        );
        // A zero-width run cannot pad a label past its cap, because the padding
        // is deleted before the cap is measured.
        let padded = format!("Installation{}access token", "\u{200B}".repeat(60));
        assert_eq!(
            sanitize_card_text(&padded, CardTextField::ValueLabel, Some("Notion"), None),
            Some("Installationaccess token".to_string()),
        );
    }

    #[test]
    fn keeps_the_two_live_packs_words() {
        assert_eq!(
            sanitize_card_text(
                "Installation access token",
                CardTextField::ValueLabel,
                Some("Notion"),
                None,
            ),
            Some("Installation access token".to_string()),
        );
        assert_eq!(
            sanitize_card_text(
                "Technical user id",
                CardTextField::ValueLabel,
                Some("FreeFinance"),
                None,
            ),
            Some("Technical user id".to_string()),
        );
        assert_eq!(
            sanitize_card_text(
                "Lets Instafy read the Notion pages you share with it.",
                CardTextField::Description,
                Some("Notion"),
                None,
            ),
            Some("Lets Instafy read the Notion pages you share with it.".to_string()),
        );
        // The same sentence on a card that did not resolve to Notion borrows a
        // name the catalogue did not grant.
        assert_eq!(
            sanitize_card_text(
                "Lets Instafy read the Notion pages you share with it.",
                CardTextField::Description,
                None,
                None,
            ),
            None
        );
        // The heading the card already puts the product name in front of.
        assert_eq!(
            sanitize_card_text(
                "Notion Installation access token",
                CardTextField::ValueLabel,
                Some("Notion"),
                None,
            ),
            Some("Installation access token".to_string()),
        );
        // A pack the catalogue does not carry may still name its own product,
        // which is the generic path this change exists to serve.
        assert_eq!(
            sanitize_card_text(
                "Lets Instafy read the events on your Google calendar.",
                CardTextField::Description,
                None,
                Some("google-calendar"),
            ),
            Some("Lets Instafy read the events on your Google calendar.".to_string()),
        );
        // A resolved owner still wins over the slug, so the attacker who
        // resolves to Notion cannot buy another product's name with one.
        assert_eq!(
            sanitize_card_text(
                "Sign in with your Google account.",
                CardTextField::Description,
                Some("Notion"),
                Some("google"),
            ),
            None
        );
    }

    #[test]
    fn validates_the_destination_and_never_cleans_it() {
        assert!(validate_secret_name("NOTION_API_KEY"));
        assert!(validate_secret_name("_private"));
        assert!(!validate_secret_name("9LIVES"));
        assert!(!validate_secret_name("NOTION-API-KEY"));
        assert!(!validate_secret_name("NOTION API KEY"));
        assert!(!validate_secret_name(""));
        assert!(!validate_secret_name(&"A".repeat(129)));
    }

    #[test]
    fn refuses_the_values_instafy_does_not_take() {
        assert_eq!(refused_secret_class("NOTION_PASSWORD"), Some("password"));
        assert_eq!(
            refused_secret_class("wallet_mnemonic"),
            Some("recovery phrase")
        );
        assert_eq!(refused_secret_class("PIN_CODE"), Some("PIN"));
        assert_eq!(refused_secret_class("CARD_NUMBER"), Some("card number"));
        assert_eq!(refused_secret_class("NOTION_API_KEY"), None);
        assert_eq!(refused_secret_class("PINNED_REPO"), None);
    }

    #[test]
    fn resolves_identity_only_when_the_name_and_the_slug_agree() {
        assert_eq!(
            resolve_connector_name("NOTION_API_KEY", Some("notion")),
            Some("Notion")
        );
        assert_eq!(
            resolve_connector_name("notion_api_key", None),
            Some("Notion")
        );
        assert_eq!(
            resolve_connector_name("NOTION_API_KEY", Some("attacker")),
            None
        );
        assert_eq!(
            resolve_connector_name("CLOUDFLARE_API_TOKEN", Some("notion")),
            None
        );
        // The pack's other two declared needs, which the catalogue did not
        // carry until the card's words came from the pack.
        assert_eq!(
            resolve_connector_name("FREEFINANCE_CLIENT_ID", Some("freefinance")),
            Some("FreeFinance")
        );
        assert_eq!(
            resolve_connector_name("FREEFINANCE_API_BASE_URL", None),
            Some("FreeFinance")
        );
    }

    #[test]
    fn cuts_a_description_but_refuses_an_over_length_heading_or_directive() {
        let long = format!("{} end of it", "word ".repeat(60));
        let cut = sanitize_card_text(&long, CardTextField::Description, None, None).expect("kept");
        assert!(cut.chars().count() <= MAX_DESCRIPTION_CHARS);
        assert!(cut.ends_with('\u{2026}'));
        assert!(!cut.contains("  "));
        assert_eq!(
            sanitize_card_text(
                "An extremely long provider on screen name for one single value",
                CardTextField::ValueLabel,
                None,
                None,
            ),
            None
        );
        // The screen this sentence names is the last thing it says, so the
        // whole sentence goes rather than the one noun the person came for.
        assert_eq!(
            sanitize_card_text(&long, CardTextField::WhereToGet, None, None),
            None
        );
    }
}
