//! The plain-language activity line of a chat turn ("Looked up 14 places, read 6 pages, built
//! the map"): the shape of the `activity` a runtime attaches to a step's message, and the rules
//! its words follow (docs/Chat-Activity.md).
//!
//! Labels come only from trusted data: a skill pack pinned with the runtime, the runtime's own
//! tables and the browser's own state. A label is never built from command output, page text or
//! text the model wrote. The only values that fill one are a count (`{n}`) and, for a browser
//! step, a host name the runtime checked (`{host}`).
//!
//! The runtime, the controller and Studio each check every label with these rules, so even a
//! misbehaving runtime can only show a short plain phrase: no links, no markup, no addresses.
//! `chat_activity_fixtures.json` pins the rules, and Studio's copy (`turnActivity.ts`) is tested
//! against the same file.

use serde_json::{Map, Value};

/// The `v` of an activity this module reads.
pub const ACTIVITY_VERSION: u64 = 1;
/// A running label ("Looking up places") is at most this many characters.
pub const MAX_LIVE_CHARS: usize = 40;
/// A done form ("looked up {n} places") is at most this many characters once `{n}` is 999.
pub const MAX_DONE_CHARS: usize = 48;
/// At most this many further labels ride along with the first one of a step.
pub const MAX_ALSO: usize = 3;
/// The largest count a step may carry.
pub const MAX_COUNT: u64 = 100_000;
/// The longest host a browser step may name.
pub const MAX_HOST_CHARS: usize = 64;

const COUNT_PLACEHOLDER: &str = "{n}";
const HOST_PLACEHOLDER: &str = "{host}";
/// Punctuation a label may use besides letters, ASCII digits and single spaces.
const LABEL_PUNCTUATION: &str = "'\u{2019},.-\u{2013}\u{b7}:;()&!?";
const ROLES: &[&str] = &["content", "outcome", "quiet"];
const APPROVALS: &[&str] = &["once", "routine", "free", "denied", "expired"];

/// Plain words: letters, ASCII digits, single spaces and a little punctuation, with no address
/// in it (`www.`, a dot inside a word, `@`, `://`, angle or square brackets, braces).
pub fn is_plain_label_text(text: &str) -> bool {
    if text.is_empty() || text.trim() != text || text.contains("  ") {
        return false;
    }
    if !text.chars().all(|character| {
        character.is_alphabetic()
            || character.is_ascii_digit()
            || character == ' '
            || LABEL_PUNCTUATION.contains(character)
    }) {
        return false;
    }
    let characters: Vec<char> = text.chars().collect();
    // "www.", "example.com", "1.5": a dot is only allowed where a sentence would put one.
    let dotted_word = characters
        .windows(2)
        .any(|pair| pair[0] == '.' && (pair[1].is_alphabetic() || pair[1].is_ascii_digit()));
    !dotted_word && !text.to_lowercase().contains("www")
}

fn without_placeholder(text: &str, placeholder: &str, allowed: bool) -> Option<String> {
    let found = text.matches(placeholder).count();
    match (found, allowed) {
        (0, _) => Some(text.to_string()),
        // A plain word stands in for the host, so the words around it follow the same rules.
        (1, true) => Some(text.replace(placeholder, "host")),
        _ => None,
    }
}

/// A running label: starts with an upper-case letter, at most [`MAX_LIVE_CHARS`] characters,
/// plain words. `{host}` is allowed once when the step names a host.
pub fn is_live_label(text: &str, allow_host: bool) -> bool {
    let Some(bare) = without_placeholder(text, HOST_PLACEHOLDER, allow_host) else {
        return false;
    };
    text.chars().count() <= MAX_LIVE_CHARS
        && bare.chars().next().is_some_and(char::is_uppercase)
        && is_plain_label_text(&bare)
}

/// A done form: starts with a lower-case letter, at most [`MAX_DONE_CHARS`] characters once
/// `{n}` is 999, plain words. `{n}` must appear exactly once where `count` is set (the `other`
/// form) and never elsewhere; `{host}` is allowed once when the step names a host.
pub fn is_done_form(text: &str, count: bool, allow_host: bool) -> bool {
    if text.matches(COUNT_PLACEHOLDER).count() != usize::from(count) {
        return false;
    }
    let filled = text.replace(COUNT_PLACEHOLDER, "999");
    let Some(bare) = without_placeholder(&filled, HOST_PLACEHOLDER, allow_host) else {
        return false;
    };
    filled.chars().count() <= MAX_DONE_CHARS
        && bare.chars().next().is_some_and(char::is_lowercase)
        && is_plain_label_text(&bare)
}

/// `done` as one form for every count, or `{one, other, some}`: `one` for a single step, `other`
/// with `{n}` for a known count, `some` when the count is not known (a loop). `some` is required
/// with `other`.
pub fn check_done(value: &Value, allow_host: bool) -> Option<Value> {
    match value {
        Value::String(text) => is_done_form(text, false, allow_host).then(|| value.clone()),
        Value::Object(forms) => {
            if forms
                .keys()
                .any(|key| !matches!(key.as_str(), "one" | "other" | "some"))
            {
                return None;
            }
            let form = |key: &str, count: bool| -> Option<Option<String>> {
                match forms.get(key) {
                    None => Some(None),
                    Some(Value::String(text)) if is_done_form(text, count, allow_host) => {
                        Some(Some(text.clone()))
                    }
                    Some(_) => None,
                }
            };
            let one = form("one", false)??;
            let other = form("other", true)?;
            let some = form("some", false)?;
            if other.is_some() && some.is_none() {
                return None;
            }
            let mut checked = Map::new();
            checked.insert("one".into(), Value::String(one));
            if let Some(other) = other {
                checked.insert("other".into(), Value::String(other));
            }
            if let Some(some) = some {
                checked.insert("some".into(), Value::String(some));
            }
            Some(Value::Object(checked))
        }
        _ => None,
    }
}

/// A host a browser step may name: lower-case letters, digits, dots and dashes (punycode for
/// other scripts), at most [`MAX_HOST_CHARS`] characters, with a dot and no `www.` in front.
pub fn is_activity_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= MAX_HOST_CHARS
        && host.contains('.')
        && !host.starts_with("www.")
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn is_activity_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key.as_bytes()[0].is_ascii_alphanumeric()
        && key.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'*' | b':')
        })
}

fn check_count(value: Option<&Value>) -> Option<Value> {
    match value {
        None => Some(Value::from(1)),
        Some(Value::Null) => Some(Value::Null),
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|count| (1..=MAX_COUNT).contains(count))
            .map(Value::from),
        Some(_) => None,
    }
}

fn check_entry(object: &Map<String, Value>, top_level: bool) -> Option<Map<String, Value>> {
    let known = |key: &str| {
        matches!(
            key,
            "key"
                | "role"
                | "live"
                | "done"
                | "count"
                | "when"
                | "host"
                | "pageKey"
                | "step"
                | "approval"
        ) || (top_level && matches!(key, "v" | "also"))
    };
    if object.keys().any(|key| !known(key)) {
        return None;
    }
    let mut checked = Map::new();
    let key = object.get("key")?.as_str()?;
    if !is_activity_key(key) {
        return None;
    }
    checked.insert("key".into(), Value::from(key));
    let role = object.get("role")?.as_str()?;
    if !ROLES.contains(&role) {
        return None;
    }
    checked.insert("role".into(), Value::from(role));
    let host = match object.get("host") {
        None => None,
        Some(Value::String(host)) if is_activity_host(host) => Some(host.as_str()),
        Some(_) => return None,
    };
    if let Some(host) = host {
        checked.insert("host".into(), Value::from(host));
    }
    if let Some(live) = object.get("live") {
        let live = live.as_str()?;
        if !is_live_label(live, host.is_some()) {
            return None;
        }
        checked.insert("live".into(), Value::from(live));
    }
    match object.get("done") {
        Some(done) => {
            checked.insert("done".into(), check_done(done, host.is_some())?);
        }
        // A step the line names when the turn is done needs words for it.
        None if role != "quiet" => return None,
        None => {}
    }
    checked.insert("count".into(), check_count(object.get("count"))?);
    if let Some(when) = object.get("when") {
        if when.as_str()? != "success" {
            return None;
        }
        checked.insert("when".into(), when.clone());
    }
    if let Some(page_key) = object.get("pageKey") {
        let page_key = page_key.as_str()?;
        if page_key.len() != 16
            || !page_key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        checked.insert("pageKey".into(), Value::from(page_key));
    }
    if let Some(step) = object.get("step") {
        let step = step.as_str()?;
        if step.is_empty()
            || step.len() > 24
            || !step.as_bytes()[0].is_ascii_lowercase()
            || !step
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        {
            return None;
        }
        checked.insert("step".into(), Value::from(step));
    }
    if let Some(approval) = object.get("approval") {
        let approval = approval.as_str()?;
        if !APPROVALS.contains(&approval) {
            return None;
        }
        checked.insert("approval".into(), Value::from(approval));
    }
    Some(checked)
}

/// Checks a step's `activity` and returns it with only the fields this version knows, or `None`
/// when anything in it breaks a rule. A caller drops an activity that fails: the step then
/// counts as an unlabelled one ("Ran 3 commands").
pub fn check_activity(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("v")?.as_u64()? != ACTIVITY_VERSION {
        return None;
    }
    let mut checked = check_entry(object, true)?;
    let also = match object.get("also") {
        None => Vec::new(),
        Some(Value::Array(items)) if items.len() <= MAX_ALSO => items
            .iter()
            .map(|item| check_entry(item.as_object()?, false).map(Value::Object))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let mut ordered = Map::new();
    ordered.insert("v".into(), Value::from(ACTIVITY_VERSION));
    ordered.append(&mut checked);
    ordered.insert("also".into(), Value::Array(also));
    Some(Value::Object(ordered))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("chat_activity_fixtures.json")).expect("fixtures")
    }

    fn strings<'a>(fixtures: &'a Value, key: &str) -> Vec<&'a str> {
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
    fn live_labels_follow_the_fixtures() {
        let fixtures = fixtures();
        for label in strings(&fixtures, "liveValid") {
            assert!(is_live_label(label, false), "{label:?} should pass");
        }
        for label in strings(&fixtures, "liveInvalid") {
            assert!(!is_live_label(label, false), "{label:?} should fail");
        }
    }

    #[test]
    fn done_forms_follow_the_fixtures() {
        let fixtures = fixtures();
        for label in strings(&fixtures, "doneValid") {
            assert!(is_done_form(label, false, false), "{label:?} should pass");
        }
        for label in strings(&fixtures, "doneInvalid") {
            assert!(!is_done_form(label, false, false), "{label:?} should fail");
        }
        for label in strings(&fixtures, "doneCountValid") {
            assert!(is_done_form(label, true, false), "{label:?} should pass");
        }
        for label in strings(&fixtures, "doneCountInvalid") {
            assert!(!is_done_form(label, true, false), "{label:?} should fail");
        }
    }

    #[test]
    fn activities_follow_the_fixtures() {
        let fixtures = fixtures();
        for case in fixtures["activityValid"].as_array().expect("activityValid") {
            let checked = check_activity(&case["activity"])
                .unwrap_or_else(|| panic!("{} should pass", case["activity"]));
            assert_eq!(checked, case["checked"], "{}", case["activity"]);
        }
        for case in fixtures["activityInvalid"]
            .as_array()
            .expect("activityInvalid")
        {
            assert_eq!(
                check_activity(&case["activity"]),
                None,
                "{} should fail: {}",
                case["activity"],
                case["why"]
            );
        }
    }

    #[test]
    fn hosts_are_plain_lower_case_names() {
        for host in ["visitlisboa.com", "xn--lisboa-9ua.pt", "a-b.example.org"] {
            assert!(is_activity_host(host), "{host}");
        }
        for host in [
            "",
            "localhost",
            "www.visitlisboa.com",
            "Visitlisboa.com",
            "visit lisboa.com",
            "visitlisboa.com/",
            "-a.com",
            "a..com",
            "user@a.com",
            &"a".repeat(65),
        ] {
            assert!(!is_activity_host(host), "{host}");
        }
    }
}
