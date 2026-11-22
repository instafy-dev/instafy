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
    /// The card opens a site whose page the turn's own reader didn't read
    /// ([`BrowserRequest::wait_for_a_press_where_it_opens`]): Studio leaves it for the person to
    /// press, also where they gave every address it opens (`waitsForThePerson`).
    waits_for_a_press: bool,
}

/// The `request_browser` actions of a reply.
fn browser_actions(reply: &Value) -> impl Iterator<Item = &serde_json::Map<String, Value>> {
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
}

/// Why each `request_browser` card of a reply is dropped as the reply is read
/// ([`BrowserRequest::parse`]), one reason per card. Nothing of such a card reaches the person,
/// while the reply beside it may still send them to the browser, so the runtime logs each one
/// with the turn's job.
pub(super) fn dropped_requests(reply: &Value) -> Vec<&'static str> {
    browser_actions(reply)
        .filter_map(|action| BrowserRequest::parse(action).err())
        .collect()
}

/// Each rule of [`REFUSED_FOR_ITS_TASK`] a reply's refused cards broke, every one of a card's:
/// [`BrowserRequest::parse`] gives only the first it meets, so a card that named no page and held
/// an e-mail address ("Check the shop's return policy for order 123-4567 associated with
/// ana@example.com.") read as one that named no page, and its retry was told nothing of the
/// address.
pub(super) fn rules_refused_cards_broke(reply: &Value) -> Vec<&'static str> {
    let mut broken = Vec::new();
    for action in browser_actions(reply) {
        let Err(rule) = BrowserRequest::parse(action) else {
            continue;
        };
        if !REFUSED_FOR_ITS_TASK.contains(&rule) {
            continue;
        }
        broken.push(rule);
        let task = action
            .get("task")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if rule == NAMES_NO_PAGE && crate::search_query::holds_an_email_address(task) {
            broken.push(HOLDS_AN_EMAIL_ADDRESS);
        }
    }
    broken
}

/// The sites of the pages a turn's own reader (`instafy web read`) didn't read, from the turn's
/// events, as Studio reads a card's hosts: each page its output marks `stopped` (a robots.txt
/// refusal, a sign-in, a refusal such as HTTP 403…) and where that page redirected; every address
/// of a read that read nothing; and, where the room kept only the end of a read's output
/// ([`crate::codex::COMMAND_OUTPUT_KEPT_TAIL`]), every address it asked for that the output it
/// kept doesn't show read. A card that opens one of them waits for the person's press
/// ([`BrowserRequest::wait_for_a_press_where_it_opens`]).
pub(super) fn sites_its_reader_did_not_read(events: &[&[Value]]) -> BTreeSet<String> {
    let mut sites = BTreeSet::new();
    for event in events.iter().copied().flatten() {
        let item = &event["item"];
        if event["type"] != "item.completed" || item["type"] != "command_execution" {
            continue;
        }
        let command = item["command"].as_str().unwrap_or_default();
        let reads_pages =
            super::activity_labels::command_activity(item.get("command_argv"), command)
                .is_some_and(|activity| activity["key"] == "instafy/web-read");
        if !reads_pages {
            continue;
        }
        let output = item["aggregated_output"].as_str().unwrap_or_default();
        let shown = read_outcomes(output);
        let asked = addresses_in(command);
        let mut not_read = shown.stopped;
        if item["exit_code"] != json!(0) {
            not_read.extend(asked);
        } else if output.starts_with(crate::codex::COMMAND_OUTPUT_KEPT_TAIL) && asked.len() > 1 {
            not_read.extend(
                asked
                    .into_iter()
                    .filter(|address| !shown.read.iter().any(|read| same_page(address, read))),
            );
        }
        sites.extend(not_read.into_iter().filter_map(site_of));
    }
    sites
}

/// What a read's output shows of its pages, as its JSON gives them (one key a line: a page's
/// `requestedUrl`, then its `status`) or its text (`[stopped: robots] <address> -> <where it
/// went>`): the addresses of the pages it marks `stopped`, where they redirected included, and of
/// those it read or found to need a browser.
struct ReadOutcomes<'a> {
    stopped: Vec<&'a str>,
    read: Vec<&'a str>,
}

fn read_outcomes(output: &str) -> ReadOutcomes<'_> {
    let mut shown = ReadOutcomes {
        stopped: Vec::new(),
        read: Vec::new(),
    };
    let mut asked: Option<&str> = None;
    let mut in_a_stop = false;
    for line in output.lines().map(str::trim) {
        if let Some((status, addresses)) =
            line.strip_prefix('[').and_then(|rest| rest.split_once(']'))
        {
            match status.split(':').next().unwrap_or_default().trim() {
                "stopped" => shown.stopped.extend(addresses_in(addresses)),
                "read" | "needs_browser" => shown
                    .read
                    .extend(addresses_in(addresses).into_iter().take(1)),
                _ => {}
            }
        } else if line.starts_with("\"requestedUrl\"") {
            asked = addresses_in(line).into_iter().next();
        } else if line.starts_with("\"status\"") {
            in_a_stop = line.contains("\"stopped\"");
            if in_a_stop {
                shown.stopped.extend(asked);
            } else if line.contains("\"read\"") || line.contains("\"needs_browser\"") {
                shown.read.extend(asked);
            }
        } else if in_a_stop && (line.starts_with("\"finalUrl\"") || line.starts_with("\"http")) {
            // Where a stopped page went: its provenance's `finalUrl`, and its `redirects`.
            shown.stopped.extend(addresses_in(line));
        }
    }
    shown
}

/// Whether two addresses are one page, as `instafy web read` writes the one it was asked for: its
/// host in lower case and its path, without the part after `#`.
fn same_page(asked: &str, shown: &str) -> bool {
    let page = |address: &str| {
        reqwest::Url::parse(address).ok().map(|mut url| {
            url.set_fragment(None);
            url
        })
    };
    page(asked).is_some_and(|asked| page(shown) == Some(asked))
}

/// An address's site as Studio reads a card's hosts ([`hosts_studio_reads`]): its host in lower
/// case, without a dot at the end or a leading `www.`.
fn site_of(address: &str) -> Option<String> {
    let url = reqwest::Url::parse(address).ok()?;
    let host = url.host_str()?.trim().to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then(|| host.to_owned())
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
            waits_for_a_press: false,
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
            waits_for_a_press: false,
        })
    }

    /// Leaves this card for the person to press when it opens a site whose page the turn's own
    /// reader didn't read (`sites`, [`sites_its_reader_did_not_read`]): Studio never opens it by
    /// itself, also where the person gave every address it opens. A page the reader couldn't read
    /// ends in its link and one card (the research skill's Stops), and Studio opened a card that
    /// named only addresses the person or an earlier reply gave by itself: on an address the
    /// person typed, the browser read with no press a page the reader was refused, robots.txt's
    /// refusal among them. Whether the browser reads such a page once they press it stays as it
    /// was. A card the routing step posts is the person's own message.
    pub(super) fn wait_for_a_press_where_it_opens(&mut self, sites: &BTreeSet<String>) {
        if !self.routed && !hosts_studio_reads(&self.task).is_disjoint(sites) {
            self.waits_for_a_press = true;
        }
    }

    /// Whether Studio leaves this card a button for the person to open, by what its task names,
    /// as Studio checks a card's task before it opens it by itself
    /// (`browserAutoStartAddressesSeen`): an address it can't check ([`studio_cannot_check`]),
    /// or a host that no text of `seen` names ([`hosts_studio_reads`]). `seen` is what the
    /// person could have read before the card: their messages and the chat's earlier replies,
    /// never the card's own turn. A task that names no host waits for nothing here. A card that
    /// opens a page the turn's reader didn't read always waits
    /// ([`Self::wait_for_a_press_where_it_opens`]).
    pub(super) fn waits_for_the_person(&self, seen: &[&str]) -> bool {
        if self.waits_for_a_press || studio_cannot_check(&self.task) {
            return true;
        }
        let seen: BTreeSet<String> = seen
            .iter()
            .flat_map(|text| hosts_studio_reads(text))
            .collect();
        !hosts_studio_reads(&self.task).is_subset(&seen)
    }

    pub(super) fn message(&self) -> JobMessage {
        let mut request = json!({ "task": self.task, "location": self.location });
        if self.continue_building {
            request["continueBuilding"] = json!(true);
        }
        if self.routed {
            request["routed"] = json!(true);
        }
        if self.waits_for_a_press {
            request["waitsForThePerson"] = json!(true);
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
/// domain or as an IPv4 address): where its addresses go, and whether it names one that can't be
/// compared with what the person read: localhost, an IPv6 literal, or a punycode or non-ASCII
/// host. Whether Studio holds a card is read as Studio reads it, name for name
/// ([`hosts_studio_reads`]).
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

/// Every host `text` names as Studio's `hostsNamedIn` reads them (`browserAutoStart.ts`), by
/// which it decides whether a card opens by itself: the host of each http(s) address, each bare
/// host wherever it stands, and each IPv4 address, lowercased, without a dot at the end or a
/// leading `www.`. To Studio a page's file name (`…/connections.html`) and a host in a query's
/// value are hosts like the site's own, so it holds a card for such a page on a site the person
/// gave unless they gave that very address. [`named_hosts`] reads only where an address goes:
/// read that way, such a card was taken to open by itself and lost its turn's words, while
/// Studio left it a button. This reader and Studio's are pinned to one list of cases,
/// `card_hosts_fixtures.json`, which Studio's test reads too.
fn hosts_studio_reads(text: &str) -> BTreeSet<String> {
    let of_addresses = addresses_in(text).into_iter().filter_map(|address| {
        reqwest::Url::parse(address)
            .ok()?
            .host_str()
            .map(str::to_owned)
    });
    let bare = bare_hosts_in(text)
        .into_iter()
        .chain(ipv4_addresses_in(text))
        .map(str::to_owned);
    of_addresses
        .chain(bare)
        .filter_map(|host| {
            let host = host.trim().to_lowercase();
            let host = host.strip_suffix('.').unwrap_or(&host);
            let host = host.strip_prefix("www.").unwrap_or(host);
            (!host.is_empty()).then(|| host.to_owned())
        })
        .collect()
}

/// Whether `text` names an address Studio can't compare with what the person read, as its
/// `namesUncheckableAddress` reads one: localhost, also among a host's labels (`app.localhost`),
/// an IPv6 literal, a host with letters beyond ASCII or written in punycode, or an http(s)
/// address that doesn't parse. A card whose task names one always waits for the person.
fn studio_cannot_check(text: &str) -> bool {
    names_localhost(text)
        || names_ipv6_literal(text)
        || names_unicode_host(text)
        || names_punycode_label(text)
        || addresses_in(text).into_iter().any(|address| {
            let authority = address
                .split_once("://")
                .map_or(address, |(_, rest)| rest)
                .split(['/', '?', '#'])
                .next()
                .unwrap_or_default();
            let punycode = |url: reqwest::Url| {
                url.host_str()
                    .map(|host| host.split('.').any(|label| label.starts_with("xn--")))
            };
            !authority.is_ascii()
                || reqwest::Url::parse(address)
                    .ok()
                    .and_then(punycode)
                    .unwrap_or(true)
        })
}

/// Each http(s) address in `text`, as Studio's `URL_PATTERN` finds them: `http://` or `https://`
/// in any letter case, not right after a letter, a digit or `_`, up to the next white space or
/// `<`, `>`, a quote, a backtick, `)` or `]`.
fn addresses_in(text: &str) -> Vec<&str> {
    // White space as a JavaScript pattern's `\s` counts it.
    let space = |c: char| {
        "\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}"
            .contains(c)
            || ('\u{2000}'..='\u{200a}').contains(&c)
    };
    let bytes = text.as_bytes();
    let starts = |at: usize, scheme: &str| {
        bytes
            .get(at..at + scheme.len())
            .is_some_and(|found| found.eq_ignore_ascii_case(scheme.as_bytes()))
    };
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let scheme = if starts(at, "https://") {
            8
        } else if starts(at, "http://") {
            7
        } else {
            0
        };
        let in_a_word = at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        let rest: usize = if scheme == 0 || in_a_word {
            0
        } else {
            text[at + scheme..]
                .chars()
                .take_while(|c| !space(*c) && !"<>\"'`)]".contains(*c))
                .map(char::len_utf8)
                .sum()
        };
        if rest == 0 {
            at += 1;
            continue;
        }
        found.push(&text[at..at + scheme + rest]);
        at += scheme + rest;
    }
    found
}

/// Each bare host in `text`, as Studio's `BARE_HOST_PATTERN` finds them: labels of ASCII letters,
/// digits and inner dashes joined by dots, ending in 2 to 63 letters, not right after a letter, a
/// digit, `@`, `.`, `_` or `-`, and not followed by a letter, a digit, a dash or a further label.
/// It finds one wherever it stands: in a path (`…/connections.html`) or a query's value too.
fn bare_hosts_in(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let joins = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'-');
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if (at == 0 || !joins(bytes[at - 1]))
            && let Some(end) = bare_host_end(bytes, at)
        {
            found.push(&text[at..end]);
            at = end;
        } else {
            at += 1;
        }
    }
    found
}

/// Where the bare host that starts at `start` ends, if one does.
fn bare_host_end(bytes: &[u8], start: usize) -> Option<usize> {
    // Where each label that a dot follows ends, after its dot.
    let mut after_dots = Vec::new();
    let mut at = start;
    loop {
        let label = at;
        while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'-') {
            at += 1;
        }
        let whole = at > label
            && bytes[label].is_ascii_alphanumeric()
            && bytes[at - 1].is_ascii_alphanumeric();
        if !whole || bytes.get(at) != Some(&b'.') {
            break;
        }
        at += 1;
        after_dots.push(at);
    }
    // The longest run of labels whose next is an ending: letters only, with nothing after it
    // that would carry the name on.
    after_dots.into_iter().rev().find_map(|ending| {
        let letters = bytes[ending..]
            .iter()
            .take_while(|c| c.is_ascii_alphabetic())
            .count();
        let end = ending + letters;
        let carries_on = match bytes.get(end) {
            None => false,
            Some(b'.') => bytes.get(end + 1).is_some_and(u8::is_ascii_alphanumeric),
            Some(c) => c.is_ascii_alphanumeric() || *c == b'-',
        };
        ((2..=63).contains(&letters) && !carries_on).then_some(end)
    })
}

/// Each IPv4 address in `text`, as Studio's `IPV4_PATTERN` finds them: four runs of one to three
/// digits joined by dots, not right after a digit or a dot, and not followed by a digit or a
/// further run.
fn ipv4_addresses_in(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let digits = |at: usize| {
        bytes[at..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let end_of = |start: usize| {
        let mut at = start;
        for run in 0..4 {
            let count = digits(at);
            if !(1..=3).contains(&count) {
                return None;
            }
            at += count;
            if run < 3 {
                if bytes.get(at) != Some(&b'.') {
                    return None;
                }
                at += 1;
            }
        }
        let carries_on = match bytes.get(at) {
            Some(b'.') => bytes.get(at + 1).is_some_and(u8::is_ascii_digit),
            _ => false,
        };
        (!carries_on).then_some(at)
    };
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if (at == 0 || !(bytes[at - 1].is_ascii_digit() || bytes[at - 1] == b'.'))
            && let Some(end) = end_of(at)
        {
            found.push(&text[at..end]);
            at = end;
        } else {
            at += 1;
        }
    }
    found
}

/// Whether `text` names `localhost`, alone or among a host's labels, as Studio's
/// `LOCALHOST_PATTERN` reads it: not right after or before a letter, a digit or a dash.
fn names_localhost(text: &str) -> bool {
    let bytes = text.as_bytes();
    let joins = |c: &u8| c.is_ascii_alphanumeric() || *c == b'-';
    (0..bytes.len()).any(|at| {
        bytes
            .get(at..at + 9)
            .is_some_and(|word| word.eq_ignore_ascii_case(b"localhost"))
            && !(at > 0 && joins(&bytes[at - 1]))
            && !bytes.get(at + 9).is_some_and(joins)
    })
}

/// Whether `text` names an IPv6 literal, as Studio's three patterns read one: in brackets, with a
/// `::`, or as eight groups.
fn names_ipv6_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let hex = |at: usize| {
        bytes
            .get(at..)
            .unwrap_or_default()
            .iter()
            .take_while(|c| c.is_ascii_hexdigit())
            .count()
    };
    let is = |at: usize, c: u8| bytes.get(at) == Some(&c);
    // `[`, hexadecimal digits, a colon, then letters, digits, colons, dots and `%` up to `]`.
    let bracketed = |at: usize| {
        if !is(at, b'[') {
            return false;
        }
        let colon = at + 1 + hex(at + 1);
        if !is(colon, b':') {
            return false;
        }
        let rest = bytes[colon + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b':' | b'.' | b'%'))
            .count();
        is(colon + 1 + rest, b']')
    };
    // Groups of one to four hexadecimal digits, each with a colon after it, at most `most` of
    // them: where they stop, and how many there were.
    let groups = |start: usize, most: usize| {
        let (mut at, mut count) = (start, 0);
        while count < most {
            let digits = hex(at);
            if !(1..=4).contains(&digits) || !is(at + digits, b':') {
                break;
            }
            at += digits + 1;
            count += 1;
        }
        (at, count)
    };
    // Groups that end in `::`, or `::` and a group.
    let compressed = |at: usize| {
        let (end, count) = groups(at, usize::MAX);
        (count > 0 && is(end, b':')) || (is(at, b':') && is(at + 1, b':') && hex(at + 2) > 0)
    };
    // Seven groups and an eighth.
    let full = |at: usize| {
        let (end, count) = groups(at, 7);
        count == 7 && hex(end) > 0
    };
    (0..bytes.len()).any(|at| {
        let apart = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b':');
        bracketed(at) || (apart && (compressed(at) || full(at)))
    })
}

/// Whether `text` names a punycode label outside an address, as Studio's last pattern reads one:
/// `xn--`, not right after a letter, a digit or a dash, then letters, digits or dashes and a dot.
fn names_punycode_label(text: &str) -> bool {
    let bytes = text.as_bytes();
    let joins = |c: &u8| c.is_ascii_alphanumeric() || *c == b'-';
    (0..bytes.len()).any(|at| {
        let rest = at + 4;
        bytes
            .get(at..rest)
            .is_some_and(|word| word.eq_ignore_ascii_case(b"xn--"))
            && !(at > 0 && joins(&bytes[at - 1]))
            && {
                let label = bytes[rest..].iter().take_while(|c| joins(c)).count();
                label > 0 && bytes.get(rest + label) == Some(&b'.')
            }
    })
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
        // A page's file name is one more host to Studio: the site alone doesn't open it, the
        // very address does.
        let page = card("Open https://www.transit.example/connections.html and find a connection.");
        assert!(page.waits_for_the_person(&["Use transit.example for the connection."]));
        assert!(!page.waits_for_the_person(&[
            "Read https://transit.example/connections.html for the connection."
        ]));
        // A building card that names no host waits for nothing here.
        let building = BrowserRequest::parse(
            json!({ "task": "Find the museum's opening hours.", "continueBuilding": true })
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert!(!building.waits_for_the_person(&[]));
    }

    /// The sites of the pages a turn's own reader didn't read come from its output, as
    /// `instafy web read` writes it: as JSON, a page it marks `stopped` and where that page
    /// redirected, never one it read; as text, the same; every address of a read that read
    /// nothing; and, where the turn's events kept only the end of a read of several pages, each
    /// page that end doesn't show read. A command that isn't the reader names none, whatever its
    /// output says. A card that opens one of those sites waits for the person's press and says so
    /// to Studio, also where the person gave its address; a card for a site the reader read, and
    /// a card the routing step posts, do not.
    #[test]
    fn a_card_waits_for_a_press_where_the_turns_reader_did_not_read_its_page() {
        let completed = |command: &str, exit_code: i64, output: &str| {
            json!({"type": "item.completed", "item": {
                "type": "command_execution", "command": command, "exit_code": exit_code,
                "status": "completed", "aggregated_output": output,
            }})
        };
        let sites = |events: &[Value]| sites_its_reader_did_not_read(&[events]);
        let set = |hosts: &[&str]| {
            hosts
                .iter()
                .map(|host| host.to_string())
                .collect::<BTreeSet<String>>()
        };
        let both = "instafy web read https://www.museum.example/en/visit https://guide.example/museum --json";
        let json_output = r#"{
 "ok": true,
 "viewer": "server fetch",
 "pages": [
  {
   "requestedUrl": "https://www.museum.example/en/visit",
   "status": "stopped",
   "code": "robots",
   "message": "robots.txt disallows this path",
   "tell": "This address only (and where it redirected): don't read it another way. Give the person the plain link.",
   "provenance": {
    "requestedUrl": "https://www.museum.example/en/visit",
    "finalUrl": "https://visit.museum.example/hours",
    "title": "",
    "readAt": "2026-11-22T10:00:00.000Z",
    "viewer": "server fetch"
   },
   "redirects": [
    "https://visit.museum.example/hours"
   ],
   "fromCache": false
  },
  {
   "requestedUrl": "https://guide.example/museum",
   "status": "read",
   "provenance": {
    "requestedUrl": "https://guide.example/museum",
    "finalUrl": "https://guide.example/museum",
    "title": "The museum",
    "readAt": "2026-11-22T10:00:02.000Z",
    "viewer": "server fetch"
   },
   "redirects": [],
   "fromCache": false,
   "text": "<untrusted_page_content>\nOpen daily.\n</untrusted_page_content>"
  }
 ]
}"#;
        assert_eq!(
            sites(&[completed(both, 0, json_output)]),
            set(&["museum.example", "visit.museum.example"])
        );
        let text_output = "[stopped: forbidden] https://shop.example/search?q=vacuum\n  the site refused the read (HTTP 403)\n  This address only (and where it redirected): don't read it another way. Give the person the plain link.\n[read] https://other.example/vacuum\n  read 2026-11-22T10:00:00.000Z by server fetch, HTTP 200";
        assert_eq!(
            sites(&[completed(
                "instafy web read https://shop.example/search?q=vacuum https://other.example/vacuum",
                0,
                text_output
            )]),
            set(&["shop.example"])
        );
        // A read that read nothing: every address it asked for.
        assert_eq!(
            sites(&[completed(
                "instafy web read https://a.example/x https://www.b.example/y --json",
                2,
                "{\n \"ok\": true\n}"
            )]),
            set(&["a.example", "b.example"])
        );
        // Only the end of a read of several pages: each page it doesn't show read. A read of one
        // page that read something read it, however little of its output is kept.
        let tail = format!(
            "{}   \"textChars\": 120\n  }},\n  {{\n   \"requestedUrl\": \"https://b.example/y\",\n   \"status\": \"read\",\n   \"text\": \"<untrusted_page_content>\\nOpen\\n</untrusted_page_content>\"\n  }}\n ]\n}}",
            crate::codex::COMMAND_OUTPUT_KEPT_TAIL
        );
        assert_eq!(
            sites(&[completed(
                "instafy web read https://a.example/x https://b.example/y --json",
                0,
                &tail
            )]),
            set(&["a.example"])
        );
        assert!(
            sites(&[completed(
                "instafy web read https://a.example/x --json",
                0,
                &tail
            )])
            .is_empty()
        );
        // Not the reader, and not a finished step.
        assert!(sites(&[completed("cat notes.txt", 0, text_output)]).is_empty());
        assert!(
            sites(&[
                json!({"type": "item.started", "item": {"type": "command_execution",
            "command": both, "exit_code": 2, "aggregated_output": json_output}})
            ])
            .is_empty()
        );

        let refused = set(&["museum.example", "visit.museum.example"]);
        let card = |task: &str| {
            BrowserRequest::parse(json!({ "task": task }).as_object().unwrap()).unwrap()
        };
        let typed = ["What are its Sunday hours? https://www.museum.example/en/visit"];
        let mut museum =
            card("Open https://www.museum.example/en/visit and find its Sunday hours.");
        assert!(!museum.waits_for_the_person(&typed), "the person gave it");
        museum.wait_for_a_press_where_it_opens(&refused);
        assert!(museum.waits_for_the_person(&typed));
        assert_eq!(
            museum.message().metadata.unwrap()["details"]["browserRequest"]["waitsForThePerson"],
            json!(true)
        );
        let mut guide = card("Open https://guide.example/museum and read its hours.");
        guide.wait_for_a_press_where_it_opens(&refused);
        assert!(!guide.waits_for_the_person(&["Read https://guide.example/museum for me."]));
        let posted = guide.message().metadata.unwrap();
        let request = &posted["details"]["browserRequest"];
        assert!(request.get("waitsForThePerson").is_none(), "{request}");
        let mut routed =
            BrowserRequest::routed("Open https://www.museum.example/en/visit for me.", false)
                .unwrap();
        routed.wait_for_a_press_where_it_opens(&refused);
        assert!(
            !routed.waits_for_the_person(&["Open https://www.museum.example/en/visit for me."])
        );
    }

    /// Whether a card waits is read as Studio reads it, name for name: the hosts a text names,
    /// and whether it names an address Studio can't check. Both readers are pinned to one list
    /// of cases, which Studio's own test reads too (`browserAutoStart.test.ts`): a rule changed
    /// on one side and not the other fails here and there at once.
    #[test]
    fn a_texts_hosts_are_read_as_studio_reads_them() {
        let fixtures: Value = serde_json::from_str(include_str!("card_hosts_fixtures.json"))
            .expect("the list of cases");
        let cases = fixtures["cases"].as_array().expect("cases");
        assert!(cases.len() >= 40, "{}", cases.len());
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let text = case["text"].as_str().expect("text");
                let hosts: BTreeSet<String> = case["hosts"]
                    .as_array()
                    .expect("hosts")
                    .iter()
                    .map(|host| host.as_str().expect("host").to_owned())
                    .collect();
                let read = (hosts_studio_reads(text), studio_cannot_check(text));
                (read != (hosts, case["uncheckable"] == true))
                    .then(|| format!("{}: {text:?} read as {read:?}", case["name"]))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}
