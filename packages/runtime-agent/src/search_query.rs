//! The query rules a managed search is sent by, for the words of a search a person's own ChatGPT
//! login ran.
//!
//! Instafy AI searches through the proxy's search bridge, which sends a query only after the query
//! rules of `instafy web search` (openai-proxy-server `search_query.rs`, `prepareQuery` in
//! `packages/instafy-cli/src/web-search.ts`) and names the words it sent, which are all the room's
//! search step names. A person's own ChatGPT login searches the AI's words as they are, on the
//! person's own plan, and nothing between the AI and the search reads them, so the step names them
//! only after the same rules (`codex::web_search_step`): characters nobody sees are taken out,
//! e-mail addresses, account numbers and long numbers (9 or more digits: phones, cards, ids) are
//! removed, and words that look like they hold a key or a password, or are longer than a query may
//! be, are not named at all.
//!
//! The patterns are the proxy's, which are the CLI's and the browser redaction's
//! (`packages/browser-action-policy/redaction.js`); change them together. Both copies are held
//! against the same cases (openai-proxy-server `tests/fixtures/search_query_cases.json`). The
//! proxy's also refuses a query that holds the key its search is sent with, which no runtime holds.

use std::sync::OnceLock;

use regex::Regex;

/// The longest query the rules pass, counted in UTF-16 code units as the CLI counts it.
const MAX_QUERY_CHARS: usize = 200;

/// A query as the rules pass it, and what they removed from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedQuery {
    pub(crate) query: String,
    /// What was removed, in the CLI's words and order: "an e-mail address", "an account number",
    /// "a long number".
    pub(crate) removed: Vec<&'static str>,
}

/// Why the rules pass none of a query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryRefusal {
    Empty,
    TooLong,
    LooksLikeSecret,
    NothingLeft,
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
            // The CLI normalizes a query to NFC first; marks are matched here instead, so a
            // decomposed letter cannot split an address.
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
                // Written as the redaction module writes it, so the source holds no token prefix.
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
            // The CLI tests these on single words, where they never match; the whole query is
            // checked here, which only refuses more.
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

/// Characters nobody sees, which could split a number or an address so the rules below miss it:
/// zero-width spaces and joiners, soft hyphens, direction marks and byte order marks. The room
/// takes the same ones out of every line it shows of a search (`codex::plain_line`), so a line
/// can never join what the rules saw apart.
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

/// Characters nobody sees are taken out, control characters become spaces, and runs of white
/// space one space.
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

/// A single opaque value that is long, mixes letters and digits and looks random (the redaction
/// module's `looksRandom`).
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

fn looks_like_secret(query: &str) -> bool {
    let patterns = patterns();
    patterns.secret_word.is_match(query)
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

/// The query as the rules pass it: white space collapsed, and e-mail addresses, account numbers
/// and long numbers removed. A query that looks like it holds a key or a password is refused, as is
/// one with nothing left.
pub(crate) fn prepare_query(raw: &str) -> Result<PreparedQuery, QueryRefusal> {
    let collapsed = collapse(raw);
    if collapsed.is_empty() {
        return Err(QueryRefusal::Empty);
    }
    if collapsed.encode_utf16().count() > MAX_QUERY_CHARS {
        return Err(QueryRefusal::TooLong);
    }
    if looks_like_secret(&collapsed) {
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
    use serde_json::Value as JsonValue;

    /// The proxy's own rules pass the same cases (openai-proxy-server `search_query.rs`), so the
    /// words the room names of a person's own search are what a managed search would have sent.
    #[test]
    fn passes_the_cases_the_proxys_query_rules_pass() {
        let cases: JsonValue = serde_json::from_str(include_str!(
            "../../openai-proxy-server/tests/fixtures/search_query_cases.json"
        ))
        .expect("the shared cases parse");
        let cases = cases["cases"].as_array().expect("a list of cases");
        assert!(!cases.is_empty());
        for case in cases {
            let query = case["query"].as_str().expect("each case names its query");
            let expected = match case["refused"].as_str() {
                Some(refusal) => Err(refusal.to_string()),
                None => Ok((
                    case["sent"].as_str().expect("a case sent").to_string(),
                    case["removed"]
                        .as_array()
                        .expect("a case says what was removed")
                        .iter()
                        .map(|what| what.as_str().expect("removed as words").to_string())
                        .collect::<Vec<_>>(),
                )),
            };
            let prepared = prepare_query(query)
                .map(|prepared| {
                    (
                        prepared.query,
                        prepared
                            .removed
                            .iter()
                            .map(|what| what.to_string())
                            .collect(),
                    )
                })
                .map_err(|refusal| {
                    match refusal {
                        QueryRefusal::Empty => "empty",
                        QueryRefusal::TooLong => "too_long",
                        QueryRefusal::LooksLikeSecret => "looks_like_secret",
                        QueryRefusal::NothingLeft => "nothing_left",
                    }
                    .to_string()
                });
            assert_eq!(prepared, expected, "{query:?}");
        }
    }

    /// The proxy refuses a query of more than 200 UTF-16 code units, so it never searched one.
    #[test]
    fn bounds_the_query_as_the_cli_counts_it() {
        assert_eq!(
            prepare_query(&"a".repeat(MAX_QUERY_CHARS)).map(|prepared| prepared.query.len()),
            Ok(MAX_QUERY_CHARS)
        );
        assert_eq!(
            prepare_query(&"a".repeat(MAX_QUERY_CHARS + 1)),
            Err(QueryRefusal::TooLong)
        );
        // A character outside the basic plane counts twice.
        assert_eq!(
            prepare_query(&"\u{1d11e}".repeat(MAX_QUERY_CHARS / 2 + 1)),
            Err(QueryRefusal::TooLong)
        );
    }
}
