//! When a spent usage window opens again, as a moment anyone can place.
//!
//! Codex words that time in this machine's own clock: "You’ve hit your usage limit. Try again at
//! Nov 14th, 2026 11:03 PM.", or the time alone when it falls on the machine's same day ("Try
//! again at 11:03 PM."). The person reading the chat is somewhere else, and so is Studio, so
//! neither can place it. Codex runs in this process, so the runtime reads that time back in the
//! same clock and writes the moment in UTC, as a Claude Code limit already names its reset ("The
//! limit resets at 2026-11-14 23:03 UTC."): "Try again at 2026-11-14 23:03 UTC.". Studio then says
//! it in each reader's own clock (frontend `usageLimitReset.ts`).

use chrono::{DateTime, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};

/// The words Codex puts before the time, in its own sentence and in its "…or try again at".
const BEFORE_THE_TIME: &str = "try again at ";

/// `message` with the time of a usage limit's "Try again at …" written as the moment in UTC.
/// Any other message, and one whose time can't be read in this machine's clock, stays as it is.
pub(crate) fn usage_limit_reset_in_utc(message: String) -> String {
    usage_limit_reset_in_utc_with(message, &Local, Local::now())
}

fn usage_limit_reset_in_utc_with<Tz: TimeZone>(
    message: String,
    clock: &Tz,
    now: DateTime<Tz>,
) -> String {
    // ASCII lowercasing keeps every byte where it was, so its offsets are the message's.
    let lower = message.to_ascii_lowercase();
    if !lower.contains("usage limit") {
        return message;
    }
    let Some(start) = lower
        .rfind(BEFORE_THE_TIME)
        .map(|at| at + BEFORE_THE_TIME.len())
    else {
        return message;
    };
    let rest = &message[start..];
    let end = rest.find(['.', '\n']).unwrap_or(rest.len());
    let Some(moment) = read_in_clock(rest[..end].trim(), clock, &now) else {
        return message;
    };
    format!(
        "{}{}{}",
        &message[..start],
        moment.with_timezone(&Utc).format("%Y-%m-%d %H:%M UTC"),
        &rest[end..]
    )
}

/// The moment a usage limit's "Try again at YYYY-MM-DD HH:MM UTC." names, as
/// [`usage_limit_reset_in_utc`] writes it, in seconds since the epoch: what the turn's
/// `ai/usage-limit` artifact tells the controller, so the agent's next turns move to a backup with
/// room until then (docs/Local-Engine-Turns.md 11.20). None for any other text, and for a time that
/// was left in the machine's own clock.
pub(crate) fn usage_limit_resets_at(message: &str) -> Option<i64> {
    let lower = message.to_ascii_lowercase();
    if !lower.contains("usage limit") {
        return None;
    }
    let start = lower.rfind(BEFORE_THE_TIME)? + BEFORE_THE_TIME.len();
    let shown = message.get(start..)?.get(..UTC_MOMENT_LEN)?;
    let moment =
        NaiveDateTime::parse_from_str(shown.strip_suffix(" UTC")?, "%Y-%m-%d %H:%M").ok()?;
    Some(moment.and_utc().timestamp())
}

/// "2026-11-14 23:03 UTC".
const UTC_MOMENT_LEN: usize = 20;

/// The time Codex wrote, in `clock`: "11:03 PM" on `now`'s day, or "Nov 14th, 2026 11:03 PM".
/// A local time a clock change skips is no moment; one it repeats is its first.
fn read_in_clock<Tz: TimeZone>(
    shown: &str,
    clock: &Tz,
    now: &DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    let local = match NaiveTime::parse_from_str(shown, "%I:%M %p") {
        Ok(time) => now.date_naive().and_time(time),
        Err(_) => NaiveDateTime::parse_from_str(&without_day_ordinal(shown)?, "%b %d, %Y %I:%M %p")
            .ok()?,
    };
    clock.from_local_datetime(&local).earliest()
}

/// "Nov 14th, 2026 11:03 PM" as "Nov 14, 2026 11:03 PM": a date Codex writes with the day's
/// ordinal, which no date format reads.
fn without_day_ordinal(shown: &str) -> Option<String> {
    let (day, rest) = shown.split_once(',')?;
    let day = ["st", "nd", "rd", "th"]
        .iter()
        .find_map(|ordinal| day.trim_end().strip_suffix(*ordinal))
        .filter(|day| day.ends_with(|c: char| c.is_ascii_digit()))?;
    Some(format!("{day},{rest}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Duration, FixedOffset};

    fn at<Tz: TimeZone>(clock: &Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Tz> {
        clock.with_ymd_and_hms(y, m, d, h, min, 0).single().unwrap()
    }

    #[test]
    fn the_utc_moment_reads_back_as_seconds_since_the_epoch() {
        assert_eq!(
            usage_limit_resets_at(
                "You\u{2019}ve hit your usage limit. Try again at 2026-11-14 23:03 UTC."
            ),
            Some(at(&Utc, 2026, 11, 14, 23, 3).timestamp())
        );
        // The time left in the machine's own clock, or no time at all, names no moment.
        assert_eq!(
            usage_limit_resets_at("You\u{2019}ve hit your usage limit. Try again at 11:03 PM."),
            None
        );
        assert_eq!(
            usage_limit_resets_at("You\u{2019}ve hit your usage limit."),
            None
        );
        assert_eq!(
            usage_limit_resets_at("Try again at 2026-11-14 23:03 UTC."),
            None
        );
        assert_eq!(
            usage_limit_resets_at("You\u{2019}ve hit your usage limit. Try again at 2026-11-"),
            None
        );
    }

    #[test]
    fn a_date_codex_wrote_in_this_machines_clock_becomes_the_moment_in_utc() {
        let now = at(&Utc, 2026, 11, 10, 9, 4);
        assert_eq!(
            usage_limit_reset_in_utc_with(
                "You\u{2019}ve hit your usage limit. Try again at Nov 14th, 2026 11:03 PM.".into(),
                &Utc,
                now,
            ),
            "You\u{2019}ve hit your usage limit. Try again at 2026-11-14 23:03 UTC."
        );
        // A machine an hour east of UTC wrote the same moment as 12:03 AM the next day.
        let east = FixedOffset::east_opt(3600).unwrap();
        assert_eq!(
            usage_limit_reset_in_utc_with(
                "You\u{2019}ve hit your usage limit. Try again at Nov 15th, 2026 12:03 AM.".into(),
                &east,
                at(&east, 2026, 11, 10, 10, 4),
            ),
            "You\u{2019}ve hit your usage limit. Try again at 2026-11-14 23:03 UTC."
        );
        for (shown, moment) in [
            ("Oct 1st, 2026 8:40 AM", "2026-10-01 08:40 UTC"),
            ("Oct 2nd, 2026 12:00 PM", "2026-10-02 12:00 UTC"),
            ("Oct 3rd, 2026 1:05 PM", "2026-10-03 13:05 UTC"),
            ("Oct 11th, 2026 11:59 PM", "2026-10-11 23:59 UTC"),
            ("Oct 23rd, 2026 8:40 AM", "2026-10-23 08:40 UTC"),
        ] {
            assert_eq!(
                usage_limit_reset_in_utc_with(
                    format!("You've hit your usage limit. Try again at {shown}."),
                    &Utc,
                    now
                ),
                format!("You've hit your usage limit. Try again at {moment}."),
                "{shown}"
            );
        }
    }

    /// Codex's own wording of a reset (codex-rs `protocol/src/error.rs`, `format_retry_timestamp`).
    fn as_codex_writes_it<Tz: TimeZone>(
        reset: DateTime<Utc>,
        clock: &Tz,
        now: DateTime<Utc>,
    ) -> String
    where
        Tz::Offset: std::fmt::Display,
    {
        let local_reset = reset.with_timezone(clock);
        if local_reset.date_naive() == now.with_timezone(clock).date_naive() {
            return local_reset.format("%-I:%M %p").to_string();
        }
        let suffix = match local_reset.day() {
            11..=13 => "th",
            day => match day % 10 {
                1 => "st",
                2 => "nd",
                3 => "rd",
                _ => "th",
            },
        };
        local_reset
            .format(&format!("%b %-d{suffix}, %Y %-I:%M %p"))
            .to_string()
    }

    #[test]
    fn every_time_codex_writes_reads_back_as_its_moment() {
        for offset in [-8 * 3600, -5 * 3600, 0, 3600, 5 * 3600 + 1800, 13 * 3600] {
            let clock = FixedOffset::east_opt(offset).unwrap();
            let mut now = at(&Utc, 2026, 1, 1, 0, 7);
            while now.year() == 2026 {
                for ahead in [Duration::minutes(5), Duration::hours(5), Duration::days(4)] {
                    let reset = now + ahead;
                    let shown = as_codex_writes_it(reset, &clock, now);
                    assert_eq!(
                        usage_limit_reset_in_utc_with(
                            format!("You\u{2019}ve hit your usage limit. Try again at {shown}."),
                            &clock,
                            now.with_timezone(&clock),
                        ),
                        format!(
                            "You\u{2019}ve hit your usage limit. Try again at {}.",
                            reset.format("%Y-%m-%d %H:%M UTC")
                        ),
                        "{shown} at {offset}"
                    );
                }
                now += Duration::hours(7) + Duration::minutes(13);
            }
        }
    }

    #[test]
    fn a_time_alone_is_on_this_machines_day() {
        let west = FixedOffset::west_opt(5 * 3600).unwrap();
        // 6:03 PM on the 14th, five hours west of UTC, is 23:03 UTC.
        assert_eq!(
            usage_limit_reset_in_utc_with(
                "You\u{2019}ve hit your usage limit. Try again at 6:03 PM.".into(),
                &west,
                at(&west, 2026, 11, 14, 9, 30),
            ),
            "You\u{2019}ve hit your usage limit. Try again at 2026-11-14 23:03 UTC."
        );
    }

    #[test]
    fn a_plans_own_sentence_keeps_its_words_around_the_time() {
        let message = "You\u{2019}ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 14th, 2026 11:03 PM.";
        assert_eq!(
            usage_limit_reset_in_utc_with(message.into(), &Utc, at(&Utc, 2026, 11, 10, 9, 4)),
            "You\u{2019}ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2026-11-14 23:03 UTC."
        );
    }

    #[test]
    fn any_other_message_or_a_time_it_cannot_read_stays_as_it_is() {
        let now = at(&Utc, 2026, 11, 10, 9, 4);
        for message in [
            "You\u{2019}ve hit your usage limit. Try again later.",
            "You've hit your usage limit. Upgrade to Pro or try again later.",
            "The upstream plan usage limit was reached.",
            "You\u{2019}ve hit your usage limit. Try again at sometime soon.",
            "You\u{2019}ve hit your usage limit. Try again at Nov 31st, 2026 11:03 PM.",
            "You\u{2019}ve hit your usage limit. Try again at 2026-11-14 23:03 UTC.",
            // Not a usage limit: a page or a reply may say this.
            "The shop said: try again at 11:03 PM.",
            "unexpected status 502 Bad Gateway: The upstream request failed.",
        ] {
            assert_eq!(
                usage_limit_reset_in_utc_with(message.into(), &Utc, now),
                message
            );
        }
    }
}
