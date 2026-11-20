use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::JobMessage;

/// Where a routed card's task names what the message carries on: a line of its own after the
/// person's words ([`routed_task`]).
const CARRIES_ON: &str = "\n\nWhat this carries on: ";
/// The most of the routing step's `summary` that line quotes.
const CARRIES_ON_MAX_CHARS: usize = 600;
/// The longest task a card carries, in UTF-16 units as Studio counts them.
const TASK_MAX_UTF16_UNITS: usize = 8_000;
/// Why a question's card a turn wrote (one that doesn't continue building) is refused when its
/// task names no page it opens: no address, as Studio reads one ([`named_hosts`]). Such a card
/// sent the browser to find the pages itself: "Find available hotels in <city>…" typed the city
/// into a booking site's search, and a shop's return policy "for order <number> associated with
/// <e-mail>" went to the shop's sign-in (a local test, Nov 19). The turn runs once more, told
/// this (`jobs::refused_browser_card`). A card that continues building says what to find for the
/// build, and naming no page is no reason to refuse it: run once more, a map turn whose card
/// named none would start its whole build again from the person's request.
pub(super) const NAMES_NO_PAGE: &str = "names no page: search first, then hand over what it found";
/// Why a card a turn wrote is refused when its task holds an e-mail address, as the search query
/// rules find one in a domain that ends in a name (`search_query::holds_an_email_address`): the
/// person's details never go into a card.
pub(super) const HOLDS_AN_EMAIL_ADDRESS: &str =
    "holds an e-mail address: the person's details never go into a card";
/// The reasons a card is refused for what its task says, rather than for how it is written.
pub(super) const REFUSED_FOR_ITS_TASK: [&str; 2] = [NAMES_NO_PAGE, HOLDS_AN_EMAIL_ADDRESS];

#[derive(Debug, Clone)]
pub(super) struct BrowserRequest {
    task: String,
    location: &'static str,
    /// Octo is building something for the person (a page, a map, files) and
    /// continues it from what the browser finds: only such a card hands the
    /// browser's findings back to a building turn (`browser_hand_back.rs`).
    /// A card for a question leaves it out, and the browser turn's reply is
    /// the answer.
    continue_building: bool,
    /// The routing step sent the person's message straight to the browser:
    /// the card's task is their own words, and Studio folds the card into its
    /// browser turn when it opens it by itself.
    routed: bool,
}

/// Why each `request_browser` card of a reply is dropped as the reply is read
/// ([`BrowserRequest::parse`]), one reason per card. Nothing of such a card reaches the person,
/// while the reply beside it may still send them to the browser, so the runtime logs each one
/// with the turn's job.
pub(super) fn dropped_requests(reply: &Value) -> Vec<&'static str> {
    reply
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|action| {
            action
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    kind.trim().to_ascii_lowercase().replace('-', "_") == "request_browser"
                })
        })
        .filter_map(|action| BrowserRequest::parse(action).err())
        .collect()
}

impl BrowserRequest {
    /// The card a reply's `request_browser` action asks for, or why none is posted: no task, a
    /// task over 8,000 characters, an unknown browser location, a question's task that names no
    /// page it opens ([`NAMES_NO_PAGE`]) or any task that holds an e-mail address
    /// ([`HOLDS_AN_EMAIL_ADDRESS`]). A card the routing step posts carries the person's own words
    /// ([`Self::routed`]).
    pub(super) fn parse(value: &serde_json::Map<String, Value>) -> Result<Self, &'static str> {
        let task = value
            .get("task")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if task.is_empty() {
            return Err("no task");
        }
        if task.encode_utf16().count() > TASK_MAX_UTF16_UNITS {
            return Err("task over 8,000 characters");
        }
        let location = match value.get("browserLocation") {
            None | Some(Value::Null) => "auto",
            Some(Value::String(location)) if location == "auto" => "auto",
            Some(Value::String(location)) if location == "device" => "device",
            Some(Value::String(location)) if location == "workspace" => "workspace",
            _ => return Err("unknown browserLocation"),
        };
        let continue_building = value.get("continueBuilding") == Some(&Value::Bool(true));
        if !continue_building {
            let (pages, uncheckable) = named_hosts(task);
            if pages.is_empty() && !uncheckable {
                return Err(NAMES_NO_PAGE);
            }
        }
        if crate::search_query::holds_an_email_address(task) {
            return Err(HOLDS_AN_EMAIL_ADDRESS);
        }
        Ok(Self {
            task: task.to_owned(),
            location,
            continue_building,
            routed: false,
        })
    }

    /// The card for a message the routing step sent straight to the browser:
    /// the person's own words are its task, and the browser is chosen as for
    /// any card. None for a message no card could carry.
    pub(super) fn routed(task: &str, continue_building: bool) -> Option<Self> {
        let task = task.trim();
        if task.is_empty() || task.encode_utf16().count() > TASK_MAX_UTF16_UNITS {
            return None;
        }
        Some(Self {
            task: task.to_owned(),
            location: "auto",
            continue_building,
            routed: true,
        })
    }

    /// Whether Studio leaves this card a button for the person to open, by what its task names,
    /// as Studio checks a card's task before it opens it by itself
    /// (`browserAutoStartAddressesSeen`): an address it can't check, or a host that no text of
    /// `seen` names ([`named_hosts`]). `seen` is what the person could have read before the
    /// card: their messages and the chat's earlier replies, never the card's own turn. A task
    /// that names no host waits for nothing here.
    pub(super) fn waits_for_the_person(&self, seen: &[&str]) -> bool {
        let (wanted, uncheckable) = named_hosts(&self.task);
        if uncheckable {
            return true;
        }
        let seen: BTreeSet<String> = seen.iter().flat_map(|text| named_hosts(text).0).collect();
        !wanted.is_subset(&seen)
    }

    pub(super) fn message(&self) -> JobMessage {
        let mut request = json!({ "task": self.task, "location": self.location });
        if self.continue_building {
            request["continueBuilding"] = json!(true);
        }
        if self.routed {
            request["routed"] = json!(true);
        }
        JobMessage {
            content: "Continue this task in Instafy's browser.".to_owned(),
            message_type: Some("action_request".to_owned()),
            metadata: Some(json!({
                "messageType": "action_request",
                "details": {
                    "testId": "browser-request-card",
                    // No line on what pressing it does: Studio opens the
                    // browser by itself where it can, and the card then reads
                    // Opening and Opened in place of its button.
                    "title": "Continue in Instafy's browser",
                    "browserRequest": request,
                    "actions": [{
                        "id": "continue-browser",
                        "label": "Open browser and continue",
                        "variant": "primary",
                        "event": "instafy:request-browser",
                        "busyLabel": "Opening browser…",
                        "testId": "browser-request-continue"
                    }]
                }
            })),
        }
    }
}

/// The task of the card for a message the routing step sent straight to the browser in a chat
/// with earlier turns: the person's words, then the routing step's `summary` as one quoted line.
/// A browser turn reads the chat's browser turns and the person's own messages, never Octo's
/// replies, so without it the words can lean on a reply it never saw ("Fill in what's still
/// missing."), while the routing step read the whole chat. Like every card's task, the line
/// names no address the person could not have seen in the chat (`seen`: its messages and
/// replies), such as one a page, a tool's output or a guess gave: a summary that names one, or
/// one that can't be checked ([`named_hosts`]), is left out, as is an empty one or one that only
/// repeats the words.
pub(super) fn routed_task(words: &str, summary: Option<&str>, seen: &[&str]) -> String {
    let words = words.trim();
    let Some(summary) = summary
        .map(|summary| summary.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|summary| !summary.is_empty() && !summary.eq_ignore_ascii_case(words))
    else {
        return words.to_owned();
    };
    let (named, uncheckable) = named_hosts(&summary);
    let seen: BTreeSet<String> = seen.iter().flat_map(|text| named_hosts(text).0).collect();
    if uncheckable || !named.is_subset(&seen) {
        return words.to_owned();
    }
    let mut quoted: String = summary.chars().take(CARRIES_ON_MAX_CHARS).collect();
    if quoted.len() < summary.len() {
        quoted.push('\u{2026}');
    }
    let task = format!("{words}{CARRIES_ON}\"{quoted}\"");
    if task.encode_utf16().count() > TASK_MAX_UTF16_UNITS {
        return words.to_owned();
    }
    task
}

/// The person's own words of a routed card's task: all of it but its summary line
/// ([`routed_task`]).
pub(super) fn routed_task_words(task: &str) -> &str {
    task.split_once(CARRIES_ON).map_or(task, |(words, _)| words)
}

/// Every host `text` names, lowercased and without a leading `www.` (in an address, as a bare
/// domain or as an IPv4 address), as Studio reads a card's task before it opens it by itself,
/// and whether it names one that can't be compared with what the person read: localhost, an
/// IPv6 literal, or a punycode or non-ASCII host.
fn named_hosts(text: &str) -> (BTreeSet<String>, bool) {
    let mut hosts = BTreeSet::new();
    let mut uncheckable = false;
    let separator = |c: char| {
        c.is_whitespace()
            || "\"'`()<>{},;!?*|\u{201c}\u{201d}\u{2018}\u{2019}\u{ab}\u{bb}".contains(c)
    };
    for word in text.split(separator) {
        let word = word.trim_matches(|c: char| c == '.' || c == ':');
        let (scheme, rest) = word
            .split_once("://")
            .map_or((false, word), |(_, rest)| (true, rest));
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        // An email address names no page to open.
        if !scheme && authority.contains('@') {
            continue;
        }
        let authority = authority.rsplit('@').next().unwrap_or_default();
        let bare = authority
            .trim_start_matches('[')
            .split(']')
            .next()
            .unwrap_or_default();
        if (bare.contains("::") || bare.matches(':').count() == 7)
            && bare
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            uncheckable = true;
            continue;
        }
        let host = authority
            .split(':')
            .next()
            .unwrap_or_default()
            .trim_matches(|c: char| c == '[' || c == ']')
            .trim_end_matches('.');
        if host.eq_ignore_ascii_case("localhost") {
            uncheckable = true;
            continue;
        }
        // Letters beyond ASCII in an address's host; a bare word is read with the whole text
        // below ([`names_unicode_host`]).
        if !host.is_ascii() {
            uncheckable |= scheme;
            continue;
        }
        let labels: Vec<&str> = host.split('.').collect();
        if labels.len() < 2
            || !labels.iter().all(|label| {
                !label.is_empty()
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            continue;
        }
        let last = labels[labels.len() - 1];
        let domain =
            (2..=63).contains(&last.len()) && last.bytes().all(|b| b.is_ascii_alphabetic());
        let ipv4 = labels.len() == 4
            && labels
                .iter()
                .all(|label| label.len() <= 3 && label.bytes().all(|b| b.is_ascii_digit()));
        if !domain && !ipv4 {
            continue;
        }
        if labels
            .iter()
            .any(|label| label.to_ascii_lowercase().starts_with("xn--"))
        {
            uncheckable = true;
            continue;
        }
        let host = host.to_ascii_lowercase();
        hosts.insert(
            host.strip_prefix("www.")
                .map_or(host.clone(), str::to_owned),
        );
    }
    (hosts, uncheckable || names_unicode_host(text))
}

/// Whether `text` names a host with letters beyond ASCII, as Studio's `namesUnicodeHost` reads
/// one: labels of letters, numbers and marks joined by an ASCII, fullwidth or ideographic dot,
/// with a fullwidth or ideographic dot before an ASCII letter or digit ("example．com"), or an
/// ASCII dot and a last label of two or more characters ("bücher.de"). A price ("€1.099"), a
/// size ("13.5″"), an abbreviation ("т.е.") or a sentence that ends in an ideographic full stop
/// names none.
fn names_unicode_host(text: &str) -> bool {
    const DOTS: [char; 4] = ['.', '\u{3002}', '\u{ff0e}', '\u{ff61}'];
    let starts = |c: char| c.is_alphanumeric();
    let continues = |c: char| {
        starts(c)
            || c == '-'
            || matches!(c, '\u{300}'..='\u{36f}' | '\u{1ab0}'..='\u{1aff}' | '\u{1dc0}'..='\u{1dff}' | '\u{20d0}'..='\u{20ff}' | '\u{fe20}'..='\u{fe2f}')
    };
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        if !starts(chars[at]) {
            at += 1;
            continue;
        }
        let mut labels: Vec<&[char]> = Vec::new();
        let mut separators: Vec<char> = Vec::new();
        let (mut start, mut end) = (at, at + 1);
        loop {
            while end < chars.len() && continues(chars[end]) {
                end += 1;
            }
            labels.push(&chars[start..end]);
            if end + 1 < chars.len() && DOTS.contains(&chars[end]) && starts(chars[end + 1]) {
                separators.push(chars[end]);
                (start, end) = (end + 1, end + 2);
            } else {
                break;
            }
        }
        let candidate = &chars[at..end];
        at = end;
        if separators.is_empty() || candidate.iter().all(char::is_ascii) {
            continue;
        }
        let wide = separators
            .iter()
            .zip(&labels[1..])
            .any(|(dot, label)| *dot != '.' && label[0].is_ascii_alphanumeric());
        let ascii = separators.contains(&'.') && labels.last().is_some_and(|last| last.len() >= 2);
        if wide || ascii {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_request_preserves_task_and_defers_device_choice_to_studio() {
        let request = BrowserRequest::parse(
            json!({"task": "Continue comparing the items on https://shop.example/compare from our earlier conversation."})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let message = request.message();
        let metadata = message.metadata.unwrap();
        assert_eq!(
            metadata["details"]["browserRequest"],
            json!({
                "task": "Continue comparing the items on https://shop.example/compare from our earlier conversation.", "location": "auto"
            })
        );
        assert_eq!(
            metadata["details"]["actions"][0]["event"],
            "instafy:request-browser"
        );
        assert!(
            metadata["details"]["browserRequest"]
                .get("runtimeId")
                .is_none()
        );
    }

    /// The card says what it is for, not what pressing it does: Studio opens
    /// it by itself where it can, and it reads Opening and Opened.
    #[test]
    fn browser_request_card_has_no_line_about_what_studio_does() {
        let request = BrowserRequest::parse(
            json!({"task": "Find the opening hours on https://museum.example/visit"})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let details = request.message().metadata.unwrap()["details"].clone();
        assert_eq!(details["title"], "Continue in Instafy's browser");
        assert!(details.get("description").is_none(), "{details}");
        assert!(!details.to_string().contains("Studio opens"), "{details}");
    }

    #[test]
    fn only_a_card_that_continues_building_says_so() {
        let building = BrowserRequest::parse(
            json!({"task": "Read https://maker.example/a and https://maker.example/b", "continueBuilding": true})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            building.message().metadata.unwrap()["details"]["browserRequest"],
            json!({"task": "Read https://maker.example/a and https://maker.example/b", "location": "auto", "continueBuilding": true})
        );
        for value in [
            json!({"task": "Find the opening hours on museum.example"}),
            json!({"task": "Find the opening hours on museum.example", "continueBuilding": null}),
            json!({"task": "Find the opening hours on museum.example", "continueBuilding": false}),
            json!({"task": "Find the opening hours on museum.example", "continueBuilding": "true"}),
        ] {
            let request = BrowserRequest::parse(value.as_object().unwrap()).unwrap();
            assert!(
                request.message().metadata.unwrap()["details"]["browserRequest"]
                    .get("continueBuilding")
                    .is_none(),
                "{value}"
            );
        }
    }

    #[test]
    fn browser_request_accepts_explicit_location_but_rejects_incomplete_or_unknown_requests() {
        for location in ["device", "workspace", "auto"] {
            let request = BrowserRequest::parse(
                json!({"task":"Inspect https://example.com/settings", "browserLocation":location})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(request.location, location);
        }
        for value in [
            json!({}),
            json!({"task":" "}),
            json!({"task":"x".repeat(8001)}),
            json!({"task":"🌍".repeat(4001)}),
            json!({"task":"Open a page", "browserLocation":42}),
            json!({"task":"Open a page", "browserLocation":"another-users-device"}),
        ] {
            assert!(BrowserRequest::parse(value.as_object().unwrap()).is_err());
        }
    }

    /// A card no one can act on posts nothing, while the reply beside it may still send the
    /// person to the browser: a reply ended "Open Instafy's browser to check…" over a card with
    /// no task, and nothing said that no card came with it. Each such card has a reason, which
    /// the runtime logs with the turn's job; a card that is posted, or another action, has none.
    #[test]
    fn a_card_dropped_for_having_no_task_says_why() {
        let reply = json!({"actions": [
            {"type": "request_browser"},
            {"type": "request_browser", "task": null, "browserLocation": null},
            {"type": " Request-Browser ", "task": " "},
            {"type": "request_browser", "task": 42},
            {"type": "request_browser", "task": "x".repeat(8001)},
            {"type": "request_browser", "task": "Open a page", "browserLocation": "another-users-device"},
            {"type": "request_browser", "task": "Find the opening hours on museum.example"},
            {"type": "request_location", "precision": "approximate"},
        ]});
        assert_eq!(
            dropped_requests(&reply),
            [
                "no task",
                "no task",
                "no task",
                "no task",
                "task over 8,000 characters",
                "unknown browserLocation",
            ]
        );
        for reply in [
            json!({"summary": "Done."}),
            json!({"summary": "Done.", "actions": null}),
            json!({"actions": [{"type": "request_browser", "task": "Find the opening hours on museum.example"}]}),
        ] {
            assert!(dropped_requests(&reply).is_empty(), "{reply}");
        }
    }

    /// A card a turn writes names each page it opens by its address: one from this chat (the
    /// person's message, a page read or a search result) or the official site of something the
    /// person named. One that names none is refused, and so is one that holds an e-mail address:
    /// a shop's policy "for order <number> associated with <e-mail>" went to the shop's sign-in,
    /// and "Find available hotels in <city>…" typed the city into a booking site's search, where
    /// a search first would have found the pages (a local test, Nov 19). An e-mail address names
    /// no page, and neither does an order number.
    #[test]
    fn a_card_names_the_pages_it_opens_and_never_the_persons_details() {
        let parsed = |task: &str| {
            BrowserRequest::parse(json!({ "task": task }).as_object().unwrap()).map(|_| ())
        };
        for task in [
            "Check the shop's return policy for order 123-4567 associated with ana@example.com.",
            "Check the shop's return policy for order 123-4567.",
            "Find available hotels in the city for 12 to 14 December, 2 adults, under 150 a night. Compare promising options and report their booking links.",
            "Continue where we left off.",
        ] {
            assert_eq!(parsed(task), Err(NAMES_NO_PAGE), "{task}");
        }
        // Hotel pages a search found, a page the chat read and the official site of a shop the
        // person named, each by its address.
        for task in [
            "Open https://www.harbour-hotel.example/rooms and https://old-town-inn.example/book, set 12 to 14 December and 2 adults, and read each room's price for those nights.",
            "Read the returns section of https://shop.example/help/returns.",
            "Open shop.example and find its warranty terms.",
        ] {
            assert_eq!(parsed(task), Ok(()), "{task}");
        }
        assert_eq!(
            parsed(
                "Open https://shop.example/help/returns and check the policy for ana@example.com."
            ),
            Err(HOLDS_AN_EMAIL_ADDRESS)
        );
        // Each is a reason the turn is told, and the runtime logs.
        let reply = json!({"actions": [
            {"type": "request_browser", "task": "Check the return policy for order 123-4567 associated with ana@example.com."},
            {"type": "request_browser", "task": "Open https://shop.example/help/returns for ana@example.com."},
            {"type": "request_browser", "task": "Read the returns section of https://shop.example/help/returns."},
        ]});
        assert_eq!(
            dropped_requests(&reply),
            [NAMES_NO_PAGE, HOLDS_AN_EMAIL_ADDRESS]
        );
        assert!(REFUSED_FOR_ITS_TASK.contains(&NAMES_NO_PAGE));
        assert!(NAMES_NO_PAGE.ends_with("search first, then hand over what it found"));
        // The card the routing step posts carries the person's own words, whatever they name.
        assert!(BrowserRequest::routed("Check the status of my last order.", false).is_some());
    }

    /// Only a question's card must name its pages: its reply is the answer, and a turn whose
    /// card is refused runs once more. A card that continues building hands the browser what to
    /// find for the build ("Find a first-visit three-day itinerary for the city… from public
    /// sources." on a map turn), and refused, it ran the whole build again from the person's
    /// request. No card holds an e-mail address, a building card's neither, nor one in an
    /// address's query; a package's version ("some-lib@5.4.2"), in an address or in words, is
    /// none.
    #[test]
    fn only_a_questions_card_must_name_its_pages_and_no_card_holds_an_email_address() {
        let building = |task: &str| json!({ "task": task, "continueBuilding": true });
        let question = |task: &str| json!({ "task": task });
        let cases = [
            (
                building(
                    "Find a first-visit three-day itinerary for the city and verify the key places from public sources.",
                ),
                Ok(()),
            ),
            (
                building(
                    "Read my last three orders on shop.example, signed in as ana@example.com.",
                ),
                Err(HOLDS_AN_EMAIL_ADDRESS),
            ),
            (
                question("Open https://cdn.example/npm/some-lib@5.4.2/ and list its files."),
                Ok(()),
            ),
            (
                question(
                    "Open https://registry.example/package/some-lib and check whether some-lib@18.3.1 is its latest version.",
                ),
                Ok(()),
            ),
            (
                question(
                    "Open https://shop.example/orders?email=ana@example.com and read the order's status.",
                ),
                Err(HOLDS_AN_EMAIL_ADDRESS),
            ),
            (
                question(
                    "Open https://shop.example/help and read what it says for ana.k@example.co.uk.",
                ),
                Err(HOLDS_AN_EMAIL_ADDRESS),
            ),
        ];
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|(card, expected)| {
                let parsed = BrowserRequest::parse(card.as_object().unwrap()).map(|_| ());
                (parsed != *expected).then(|| format!("{card}: {parsed:?}, not {expected:?}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// A card waits for the person, as Studio decides it, when its task names a host nothing the
    /// person could have read before it shows, or an address Studio can't check; one naming only
    /// hosts the person or an earlier reply gave, or none, opens by itself. `www.` and letter case
    /// are nobody's, and an e-mail address's domain is no host anyone gave.
    #[test]
    fn a_card_waits_for_the_person_when_its_task_names_a_host_nobody_showed_them() {
        let card = |task: &str| {
            BrowserRequest::parse(json!({ "task": task }).as_object().unwrap()).unwrap()
        };
        let policy = card(
            "Open https://www.shop.example/us/help/returns/policy/ and explain the return policy.",
        );
        // The person named the shop, not its site.
        assert!(policy.waits_for_the_person(&["What is the shop's return policy for it?"]));
        assert!(policy.waits_for_the_person(&[]));
        // They gave the site, or an earlier reply did.
        assert!(!policy.waits_for_the_person(&["Check Shop.example's returns page for me."]));
        assert!(!policy.waits_for_the_person(&[
            "What is the shop's return policy?",
            "Its policy is at https://www.shop.example/us/help/returns/.",
        ]));
        assert!(policy.waits_for_the_person(&["Write to help@shop.example for me."]));
        // Every host it names counts.
        let two = card("Compare https://shop.example/a and https://other.example/b.");
        assert!(two.waits_for_the_person(&["Look at shop.example."]));
        assert!(!two.waits_for_the_person(&["Look at shop.example and other.example."]));
        // An address Studio can't check always waits.
        assert!(
            card("Open http://localhost:3000/ and read it.")
                .waits_for_the_person(&["Open http://localhost:3000/ and read it."])
        );
        // A building card that names no host waits for nothing here.
        let building = BrowserRequest::parse(
            json!({ "task": "Find the museum's opening hours.", "continueBuilding": true })
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert!(!building.waits_for_the_person(&[]));
    }
}
