//! The query rules of `instafy web search` (`prepareQuery` in
//! `packages/instafy-cli/src/web-search.ts`), for the searches the proxy runs
//! itself on the operator's credentials. A query keeps only words: e-mail
//! addresses, account numbers and long numbers (9 or more digits: phones,
//! cards, ids) are removed, and a query that looks like it holds a key or a
//! password is never sent. Characters nobody sees are taken out first, so
//! they cannot hide a number or an address. The patterns are the CLI's and
//! the browser redaction's (`packages/browser-action-policy/redaction.js`);
//! change them together.
//!
//! Numbers shorter than 9 digits, such as a 7-digit order number, pass, as
//! they do in the CLI: the skills' rule that a query never holds a personal
//! detail still matters.

use std::sync::OnceLock;

use regex::Regex;

/// The longest query that is sent, counted in UTF-16 code units as the CLI
/// counts it.
pub(crate) const MAX_QUERY_CHARS: usize = 200;

/// A query as it is sent, and what was removed from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedQuery {
    pub(crate) query: String,
    /// What was removed, in the CLI's words and order: "an e-mail address",
    /// "an account number", "a long number".
    pub(crate) removed: Vec<&'static str>,
}

/// Why a query is not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryRefusal {
    Empty,
    TooLong,
    LooksLikeSecret,
    NothingLeft,
}

impl QueryRefusal {
    /// The CLI's words for the refusal.
    pub(crate) fn tell(self) -> &'static str {
        match self {
            Self::Empty => "Give the words to search for.",
            Self::TooLong => "A query is at most 200 characters.",
            Self::LooksLikeSecret => {
                "This query looks like it holds a key or a password, so it was not sent. Search only with words from the person's request."
            }
            Self::NothingLeft => "Nothing was left to search after removing personal details.",
        }
    }
}

struct Patterns {
    secret_word: Regex,
    email: Regex,
    iban: Regex,
    long_number: Regex,
    /// Known key and token formats, tested on each word.
    known_formats: Vec<Regex>,
    /// The two known formats that span a space, tested on the whole query.
    spanning_formats: Vec<Regex>,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |source: &str| Regex::new(source).expect("query rule pattern compiles");
        Patterns {
            secret_word: compile(
                r"(?i)(?-u:\b)(?:pass(?:word|wd|code|phrase)?|pwd|pin|otp|api[ _-]?key|access[ _-]?key|secret|token|private[ _-]?key)\s*[:=]\s*\S+",
            ),
            // The CLI normalizes a query to NFC first; marks are matched here
            // instead, so a decomposed letter cannot split an address.
            email: compile(
                r"[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+",
            ),
            iban: compile(
                r"(?-u:\b)[A-Z]{2}[0-9]{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?(?-u:\b)",
            ),
            long_number: compile(r"\+?[0-9][0-9\s().-]{7,}[0-9]"),
            known_formats: [
                r"(?-u:\b)sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
                r"(?-u:\b)[rs]k_(?:live|test|prod)_[A-Za-z0-9]{12,}",
                r"(?-u:\b)rk_[A-Za-z0-9]{20,}",
                r"(?-u:\b)whsec_[A-Za-z0-9+/=]{16,}",
                r"(?-u:\b)gh[opsur]_[A-Za-z0-9]{30,}",
                // Written as the redaction module writes it, so the source
                // holds no token prefix.
                r"(?-u:\b)github_pa[t]_[A-Za-z0-9_]{30,}",
                r"(?-u:\b)glpat-[A-Za-z0-9_-]{20,}",
                r"(?-u:\b)xox[a-z]-[A-Za-z0-9-]{10,}",
                r"(?-u:\b)(?:AKIA|ASIA)[A-Z0-9]{16}(?-u:\b)",
                r"(?-u:\b)AIza[0-9A-Za-z_-]{30,}",
                r"(?-u:\b)ya29\.[0-9A-Za-z_-]{20,}",
                r"(?-u:\b)npm_[A-Za-z0-9]{30,}",
                r"(?-u:\b)hf_[A-Za-z0-9]{30,}",
                r"(?-u:\b)shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}",
                r"(?-u:\b)ntn_[A-Za-z0-9]{30,}",
                r"(?-u:\b)secret_[A-Za-z0-9]{30,}",
                r"(?-u:\b)SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}",
                r"(?-u:\b)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
            ]
            .into_iter()
            .map(compile)
            .collect(),
            // The CLI tests these on single words, where they never match;
            // the whole query is checked here, which only refuses more.
            spanning_formats: [
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
                r"(?-u:\b)Bearer\s+[A-Za-z0-9._~+/-]{16,}",
            ]
            .into_iter()
            .map(compile)
            .collect(),
        }
    })
}

/// Characters nobody sees, which could split a number or an address so the
/// rules below miss it: zero-width spaces and joiners, soft hyphens, direction
/// marks and byte order marks. The CLI's `\s` takes a byte order mark for a
/// space; these are taken out, which only removes more.
pub(crate) fn invisible(character: char) -> bool {
    matches!(
        character,
        '\u{00ad}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{feff}'
    )
}

/// Characters nobody sees are taken out, control characters become spaces,
/// and runs of white space one space.
fn collapse(raw: &str) -> String {
    raw.chars()
        .filter(|character| !invisible(*character))
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn shannon_entropy(value: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut total = 0usize;
    for character in value.chars() {
        *counts.entry(character).or_insert(0usize) += 1;
        total += 1;
    }
    counts
        .values()
        .map(|count| {
            let probability = *count as f64 / total as f64;
            -probability * probability.log2()
        })
        .sum()
}

/// A single opaque value that is long, mixes letters and digits and looks
/// random (the redaction module's `looksRandom`).
fn looks_random(value: &str, minimum_length: usize) -> bool {
    let length = value.chars().count();
    if length < minimum_length || length > 4096 {
        return false;
    }
    if !value
        .chars()
        .any(|character| character.is_ascii_alphabetic())
        || !value.chars().any(|character| character.is_ascii_digit())
    {
        return false;
    }
    shannon_entropy(value) >= 3.5
}

/// A word without the punctuation around it, as the CLI trims it.
fn bare_word(word: &str) -> &str {
    let word_character = |character: char| character.is_ascii_alphanumeric() || character == '_';
    word.trim_start_matches(|character: char| !(word_character(character) || character == '-'))
        .trim_end_matches(|character: char| {
            !(word_character(character) || character == '=' || character == '-')
        })
}

fn looks_like_secret(query: &str, keys: &[&str]) -> bool {
    let patterns = patterns();
    patterns.secret_word.is_match(query)
        || keys
            .iter()
            .any(|key| key.encode_utf16().count() >= 8 && query.contains(key))
        || patterns
            .spanning_formats
            .iter()
            .any(|pattern| pattern.is_match(query))
        || query.split(' ').any(|word| {
            let token = bare_word(word);
            patterns
                .known_formats
                .iter()
                .any(|pattern| pattern.is_match(token))
                || looks_random(token, 20)
        })
}

/// The query as it is sent: white space collapsed, and e-mail addresses,
/// account numbers and long numbers removed. `keys` are keys a query must
/// never carry, such as the one the search is sent with. A query that looks
/// like it holds a key or a password is refused, as is one with nothing left.
pub(crate) fn prepare_query(raw: &str, keys: &[&str]) -> Result<PreparedQuery, QueryRefusal> {
    let collapsed = collapse(raw);
    if collapsed.is_empty() {
        return Err(QueryRefusal::Empty);
    }
    if collapsed.encode_utf16().count() > MAX_QUERY_CHARS {
        return Err(QueryRefusal::TooLong);
    }
    if looks_like_secret(&collapsed, keys) {
        return Err(QueryRefusal::LooksLikeSecret);
    }
    let patterns = patterns();
    let mut removed = Vec::new();
    let mut remove = |pattern: &Regex, what: &'static str, text: &str, keep: fn(&str) -> bool| {
        pattern
            .replace_all(text, |captures: &regex::Captures<'_>| {
                let found = &captures[0];
                if keep(found) {
                    return found.to_string();
                }
                if !removed.contains(&what) {
                    removed.push(what);
                }
                " ".to_string()
            })
            .into_owned()
    };
    let query = remove(&patterns.email, "an e-mail address", &collapsed, |_| false);
    let query = remove(&patterns.iban, "an account number", &query, |_| false);
    let query = remove(&patterns.long_number, "a long number", &query, |found| {
        found.chars().filter(char::is_ascii_digit).count() < 9
    });
    let query = collapse(&query);
    if query.is_empty() {
        return Err(QueryRefusal::NothingLeft);
    }
    Ok(PreparedQuery { query, removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key no other rule catches: no digits, and no known format.
    const KEY: &str = "zz-test-platform-credential";

    // The CLI's own cases (packages/instafy-cli/test/web-search.spec.ts,
    // "refuses a query that looks like a key or a password, and removes
    // personal details before sending"), with the key a search is sent with.
    #[test]
    fn refuses_what_the_cli_refuses() {
        for query in [
            "login sk-proj-abcdefghijklmnopqrstuvwx1234",
            "password: hunter2 gmail",
            "wifi pwd=Tr0ub4dor&3",
            "7fQ2xK9pLmZ3vB8nW4rT6yH1jD5sA0cE",
            KEY,
            concat!("reset gh", "p_abcdefghijklmnopqrstuvwxyz0123456789 repo"),
            "token=abc123",
            "-----BEGIN RSA PRIVATE KEY----- MIIE",
            "Bearer abcdefghijklmnopqrstuvwxyz012345",
        ] {
            assert_eq!(
                prepare_query(query, &[KEY]),
                Err(QueryRefusal::LooksLikeSecret),
                "{query}"
            );
        }
        // The key is refused inside other words too.
        assert_eq!(
            prepare_query(&format!("weather {KEY}x lisbon"), &[KEY]),
            Err(QueryRefusal::LooksLikeSecret)
        );
    }

    #[test]
    fn removes_personal_details_as_the_cli_does() {
        assert_eq!(
            prepare_query(
                "dentist near anna.berg@example.com call +46 70 123 45 67 Stockholm 2026-11-12",
                &[KEY]
            ),
            Ok(PreparedQuery {
                query: "dentist near call Stockholm 2026-11-12".into(),
                removed: vec!["an e-mail address", "a long number"],
            })
        );
        assert_eq!(
            prepare_query("trail shoes under 120 size 44", &[KEY]),
            Ok(PreparedQuery {
                query: "trail shoes under 120 size 44".into(),
                removed: vec![],
            })
        );
        assert_eq!(
            prepare_query("fees to DE89 3704 0044 0532 0130 00 abroad", &[KEY]),
            Ok(PreparedQuery {
                query: "fees to abroad".into(),
                removed: vec!["an account number"],
            })
        );
        // A decomposed letter does not keep an address in the query.
        assert_eq!(
            prepare_query("contact jose\u{301}@example.com hours", &[KEY]).map(|q| q.query),
            Ok("contact hours".into())
        );
        // Under 9 digits a number stays, as in the CLI: the skills' rule
        // covers an order number like this one.
        assert_eq!(
            prepare_query("return policy order 123-4567", &[KEY]).map(|q| q.query),
            Ok("return policy order 123-4567".into())
        );
        assert_eq!(
            prepare_query("card 4111 1111 1111 1111 limit", &[KEY]),
            Ok(PreparedQuery {
                query: "card limit".into(),
                removed: vec!["a long number"],
            })
        );
    }

    #[test]
    fn characters_nobody_sees_hide_no_number_or_address() {
        // A byte order mark between digit groups, as the CLI's `\s` takes it.
        assert_eq!(
            prepare_query(
                "card 4111\u{feff}1111\u{feff}1111\u{feff}1111 limit",
                &[KEY]
            ),
            Ok(PreparedQuery {
                query: "card limit".into(),
                removed: vec!["a long number"],
            })
        );
        // Zero-width spaces and joiners, soft hyphens and direction marks.
        for (raw, sent) in [
            ("call +351\u{200b}912\u{200b}345\u{200b}678 now", "call now"),
            ("write to ana\u{200b}@example.com today", "write to today"),
            (
                "iban DE89\u{2060}3704\u{00ad}0044\u{200d}0532\u{200c}0130\u{200e}00 fees",
                "iban fees",
            ),
        ] {
            assert_eq!(
                prepare_query(raw, &[KEY]).map(|q| q.query),
                Ok(sent.into()),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn collapses_space_and_bounds_the_query() {
        assert_eq!(
            prepare_query(" opening\u{0}hours\t\n museum ", &[]).map(|q| q.query),
            Ok("opening hours museum".into())
        );
        assert_eq!(prepare_query(" \t ", &[]), Err(QueryRefusal::Empty));
        assert_eq!(
            prepare_query(&"a".repeat(MAX_QUERY_CHARS), &[]).map(|q| q.query.len()),
            Ok(MAX_QUERY_CHARS)
        );
        assert_eq!(
            prepare_query(&"a".repeat(MAX_QUERY_CHARS + 1), &[]),
            Err(QueryRefusal::TooLong)
        );
        assert_eq!(
            prepare_query("ana@example.com +351 912 345 678", &[]),
            Err(QueryRefusal::NothingLeft)
        );
        // A short key is never matched as text.
        assert!(prepare_query("short key", &["key"]).is_ok());
    }
}
