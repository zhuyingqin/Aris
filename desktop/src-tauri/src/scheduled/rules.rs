//! Calendar rules for scheduled tasks: one-shot, interval, Cron and RRULE,
//! each evaluated in an explicit IANA time zone.
//!
//! Pure arithmetic — no disk, no clock. Every function takes the instant it
//! reasons about as an argument, which is what lets the tests walk a rule
//! across a DST transition or a simulated restart without waiting for one.
//!
//! Instants are UTC epoch milliseconds throughout; wall-clock values only
//! exist at the edges (what the user typed, what the UI shows).
//!
//! ## DST
//!
//! There is one rule for turning a wall-clock time into an instant, and every
//! kind that has a wall-clock component goes through it ([`resolve_local`]):
//!
//! - **Gap** (spring forward, the local time never happens): the time is read
//!   with the UTC offset in force before the gap, i.e. pushed forward by the
//!   length of the gap. 02:30 on a New York spring-forward day is 03:30 EDT.
//! - **Fold** (fall back, the local time happens twice): the first one.
//!
//! That is RFC 5545 §3.3.5, and it is also what the `rrule` crate does
//! internally, so RRULE, one-shot and day-interval rules agree. Cron is the
//! documented exception: `croner` follows Vixie cron, where a *fixed-time*
//! job in a gap runs at the first valid minute after it and runs once in a
//! fold, while a *wildcard/step* job skips minutes that do not exist and runs
//! for both passes of a repeated hour — which is what a `*/15` job's author
//! expects from "every fifteen minutes".
//!
//! Minute and hour intervals are elapsed time, so they are untouched by DST by
//! construction: "every 6 hours" is always six real hours apart.

use std::str::FromStr;

use chrono::{DateTime, Duration, LocalResult, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;

pub(crate) const RULE_ONCE: &str = "once";
pub(crate) const RULE_INTERVAL: &str = "interval";
pub(crate) const RULE_CRON: &str = "cron";
pub(crate) const RULE_RRULE: &str = "rrule";

/// How many occurrences a missed-run count walks before it stops counting and
/// reports "at least this many". The count is informational (it goes into the
/// delivery record), so it must never be the thing that makes a tick slow.
pub(crate) const MISSED_COUNT_CAP: u32 = 10_000;

/// Iteration budget for one RRULE search. The crate iterates from DTSTART, so
/// the cost of a search grows with the age of the rule; HOURLY for a century
/// is ~880k steps. Beyond this the rule is reported as having no further
/// occurrences rather than stalling the runner.
const RRULE_ITERATION_BUDGET: u32 = 1_000_000;

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IntervalUnit {
    Minutes,
    Hours,
    Days,
}

impl IntervalUnit {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "minutes" => Ok(Self::Minutes),
            "hours" => Ok(Self::Hours),
            "days" => Ok(Self::Days),
            _ => Err("scheduled task interval unit must be minutes, hours, or days".to_string()),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Minutes => "minutes",
            Self::Hours => "hours",
            Self::Days => "days",
        }
    }
}

#[derive(Clone)]
enum Rule {
    Once {
        at: i64,
    },
    /// Minutes/hours: `anchor + k·step` for `k ≥ 0`, elapsed time.
    /// Days: `anchor_local + k·value days` on the wall clock, each resolved
    /// on its own — so a daily 09:00 stays 09:00 across a DST change.
    Interval {
        value: u32,
        unit: IntervalUnit,
        anchor: i64,
        anchor_local: NaiveDateTime,
    },
    Cron {
        cron: croner::Cron,
    },
    RRule {
        set: rrule::RRuleSet,
    },
}

/// A compiled rule plus the zone it is read in.
#[derive(Clone)]
pub(crate) struct Schedule {
    tz: Tz,
    rule: Rule,
}

/// The occurrences that fell due inside a window, folded to what a dispatcher
/// needs: the latest one and how many there were.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DueWindow {
    pub latest: i64,
    pub earliest: i64,
    /// Occurrences in the window, the latest included. Saturates at
    /// [`MISSED_COUNT_CAP`].
    pub count: u32,
}

pub(crate) fn parse_time_zone(raw: &str) -> Result<Tz, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("a scheduled task needs an explicit IANA time zone".to_string());
    }
    Tz::from_str(name).map_err(|_| format!("'{name}' is not an IANA time zone this build knows"))
}

/// The machine's own IANA zone, for records written before zones were
/// explicit. Falls back to UTC when the OS names a zone chrono-tz lacks.
pub(crate) fn system_time_zone() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|name| Tz::from_str(&name).ok())
        .unwrap_or(Tz::UTC)
}

/// `YYYY-MM-DDTHH:MM[:SS]`, the value of an `<input type="datetime-local">`.
/// Seconds are dropped: rules have minute granularity.
pub(crate) fn parse_local(raw: &str) -> Result<NaiveDateTime, String> {
    let text = raw.trim();
    let parsed = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M"))
        .map_err(|_| format!("'{text}' is not a date and time (expected YYYY-MM-DDTHH:MM)"))?;
    Ok(truncate_to_minute(parsed))
}

pub(crate) fn format_local(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M").to_string()
}

fn truncate_to_minute(value: NaiveDateTime) -> NaiveDateTime {
    use chrono::Timelike;
    value
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(value)
}

/// Turn a wall-clock time in `tz` into an instant (see the module docs).
pub(crate) fn resolve_local(tz: Tz, naive: NaiveDateTime) -> DateTime<Tz> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(instant) => instant,
        LocalResult::Ambiguous(earlier, later) => earlier.min(later),
        LocalResult::None => {
            // The offset in force a day before the gap. A day is far enough
            // back to be on the near side of any real transition (Samoa's
            // skipped day included) and near enough not to cross another.
            let probe = naive - Duration::hours(24);
            let before = tz.offset_from_utc_datetime(&probe).fix();
            let utc = naive - Duration::seconds(i64::from(before.local_minus_utc()));
            Utc.from_utc_datetime(&utc).with_timezone(&tz)
        }
    }
}

pub(crate) fn instant(tz: Tz, millis: i64) -> DateTime<Tz> {
    Utc.timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).single().expect("epoch"))
        .with_timezone(&tz)
}

/// The wall clock in `tz` at `millis`.
pub(crate) fn local_at(tz: Tz, millis: i64) -> NaiveDateTime {
    instant(tz, millis).naive_local()
}

impl Schedule {
    pub(crate) fn time_zone(&self) -> Tz {
        self.tz
    }

    pub(crate) fn once(tz: Tz, at: i64) -> Self {
        Self {
            tz,
            rule: Rule::Once { at },
        }
    }

    /// `anchor_local` is the wall-clock time of the first occurrence when the
    /// user typed one. Without it the anchor instant's own wall clock is used.
    pub(crate) fn interval(
        tz: Tz,
        value: u32,
        unit: IntervalUnit,
        anchor: i64,
        anchor_local: Option<NaiveDateTime>,
    ) -> Result<Self, String> {
        if value == 0 || value > 10_000 {
            return Err("scheduled task interval must be between 1 and 10000".to_string());
        }
        let anchor_local = anchor_local.unwrap_or_else(|| local_at(tz, anchor));
        let anchor = if unit == IntervalUnit::Days {
            resolve_local(tz, anchor_local).timestamp_millis()
        } else {
            anchor
        };
        Ok(Self {
            tz,
            rule: Rule::Interval {
                value,
                unit,
                anchor,
                anchor_local,
            },
        })
    }

    /// Five-field Vixie Cron: minute hour day-of-month month day-of-week.
    pub(crate) fn cron(tz: Tz, expression: &str) -> Result<Self, String> {
        let expression = expression.trim();
        if expression.is_empty() {
            return Err("a Cron rule needs an expression such as '0 9 * * 1-5'".to_string());
        }
        if expression.split_whitespace().count() != 5 && !expression.starts_with('@') {
            return Err(
                "Cron rules here have five fields: minute hour day-of-month month day-of-week"
                    .to_string(),
            );
        }
        let cron = croner::parser::CronParser::builder()
            .seconds(croner::parser::Seconds::Disallowed)
            .year(croner::parser::Year::Disallowed)
            .build()
            .parse(expression)
            .map_err(|error| format!("invalid Cron expression '{expression}': {error}"))?;
        Ok(Self {
            tz,
            rule: Rule::Cron { cron },
        })
    }

    /// RFC 5545 recurrence. `text` is either a bare rule (`FREQ=WEEKLY;…`,
    /// with or without the `RRULE:` prefix) or a full `DTSTART…\nRRULE:…`
    /// pair. A bare rule, or a DTSTART without a zone, is anchored at
    /// `default_start` in `tz` — a floating DTSTART would otherwise be read in
    /// whatever zone the machine is in. A DTSTART with its own `TZID` (or `Z`)
    /// keeps it, and that zone becomes the schedule's zone.
    ///
    /// Returns the schedule and its normalised two-line text.
    pub(crate) fn rrule(
        tz: Tz,
        text: &str,
        default_start: NaiveDateTime,
    ) -> Result<(Self, String), String> {
        let normalized = normalize_rrule_text(tz, text, default_start)?;
        let set: rrule::RRuleSet = normalized
            .parse()
            .map_err(|error: rrule::RRuleError| format!("invalid RRULE: {error}"))?;
        let rules = set.get_rrule();
        if rules.len() != 1 {
            return Err("an RRULE schedule takes exactly one RRULE line".to_string());
        }
        if matches!(
            rules[0].get_freq(),
            rrule::Frequency::Minutely | rrule::Frequency::Secondly
        ) {
            return Err(
                "RRULE frequencies finer than HOURLY are not supported; use an interval or a Cron rule"
                    .to_string(),
            );
        }
        let zone = match set.get_dt_start().timezone() {
            rrule::Tz::Tz(zone) => zone,
            rrule::Tz::Local(_) => tz,
        };
        Ok((
            Self {
                tz: zone,
                rule: Rule::RRule { set },
            },
            normalized,
        ))
    }

    /// The first occurrence strictly after `after`.
    pub(crate) fn next_after(&self, after: i64) -> Option<i64> {
        match &self.rule {
            Rule::Once { at } => (*at > after).then_some(*at),
            Rule::Interval {
                value,
                unit,
                anchor,
                anchor_local,
            } => match unit {
                IntervalUnit::Days => {
                    let step = i64::from(*value);
                    // Estimate k from elapsed time, then walk: DST moves an
                    // occurrence by at most a few hours, never a whole step.
                    let elapsed_days = (after - anchor).div_euclid(24 * HOUR_MS);
                    let mut k = (elapsed_days / step - 1).max(0);
                    loop {
                        let at = self.day_occurrence(*anchor_local, step, k)?;
                        if at > after {
                            return Some(at);
                        }
                        k += 1;
                    }
                }
                _ => {
                    let step = interval_step_ms(*value, *unit);
                    if after < *anchor {
                        return Some(*anchor);
                    }
                    let k = (after - anchor) / step + 1;
                    anchor.checked_add(k.checked_mul(step)?)
                }
            },
            Rule::Cron { cron } => cron
                .find_next_occurrence(&instant(self.tz, after), false)
                .ok()
                .map(|next| next.timestamp_millis()),
            Rule::RRule { set } => {
                let mut budget = RRULE_ITERATION_BUDGET;
                for occurrence in set {
                    let at = occurrence.timestamp_millis();
                    if at > after {
                        return Some(at);
                    }
                    budget -= 1;
                    if budget == 0 {
                        return None;
                    }
                }
                None
            }
        }
    }

    /// The latest occurrence at or before `at`, if any.
    pub(crate) fn latest_at_or_before(&self, at: i64) -> Option<i64> {
        match &self.rule {
            Rule::Once { at: once } => (*once <= at).then_some(*once),
            Rule::Interval {
                value,
                unit,
                anchor,
                anchor_local,
            } => {
                if at < *anchor {
                    return None;
                }
                match unit {
                    IntervalUnit::Days => {
                        let step = i64::from(*value);
                        let elapsed_days = (at - anchor).div_euclid(24 * HOUR_MS);
                        let mut k = elapsed_days / step + 1;
                        loop {
                            if k < 0 {
                                return None;
                            }
                            let candidate = self.day_occurrence(*anchor_local, step, k)?;
                            if candidate <= at {
                                return Some(candidate);
                            }
                            k -= 1;
                        }
                    }
                    _ => {
                        let step = interval_step_ms(*value, *unit);
                        Some(anchor + (at - anchor) / step * step)
                    }
                }
            }
            Rule::Cron { cron } => cron
                .find_previous_occurrence(&instant(self.tz, at), true)
                .ok()
                .map(|previous| previous.timestamp_millis()),
            Rule::RRule { set } => {
                let mut latest = None;
                let mut budget = RRULE_ITERATION_BUDGET;
                for occurrence in set {
                    let value = occurrence.timestamp_millis();
                    if value > at {
                        break;
                    }
                    latest = Some(value);
                    budget -= 1;
                    if budget == 0 {
                        break;
                    }
                }
                latest
            }
        }
    }

    /// Fold the occurrences in `[from, to]` into the latest one plus a count.
    /// `None` when nothing fell due.
    pub(crate) fn due_window(&self, from: i64, to: i64) -> Option<DueWindow> {
        if from > to {
            return None;
        }
        if let Rule::RRule { set } = &self.rule {
            // One pass: the crate iterates from DTSTART, so the generic
            // "next_after per step" walk below would be quadratic here.
            let mut window: Option<DueWindow> = None;
            let mut budget = RRULE_ITERATION_BUDGET;
            for occurrence in set {
                let at = occurrence.timestamp_millis();
                if at > to {
                    break;
                }
                if at >= from {
                    window = Some(match window {
                        None => DueWindow {
                            latest: at,
                            earliest: at,
                            count: 1,
                        },
                        Some(previous) => DueWindow {
                            latest: at,
                            earliest: previous.earliest,
                            count: previous.count.saturating_add(1).min(MISSED_COUNT_CAP),
                        },
                    });
                }
                budget -= 1;
                if budget == 0 {
                    break;
                }
            }
            return window;
        }
        let earliest = self.next_after(from.saturating_sub(1))?;
        if earliest > to {
            return None;
        }
        let latest = self.latest_at_or_before(to)?.max(earliest);
        let count = match &self.rule {
            Rule::Interval {
                value,
                unit: unit @ (IntervalUnit::Minutes | IntervalUnit::Hours),
                ..
            } => {
                let step = interval_step_ms(*value, *unit);
                let spans = (latest - earliest) / step + 1;
                u32::try_from(spans)
                    .unwrap_or(MISSED_COUNT_CAP)
                    .min(MISSED_COUNT_CAP)
            }
            _ => {
                let mut count = 1u32;
                let mut cursor = earliest;
                while count < MISSED_COUNT_CAP {
                    match self.next_after(cursor) {
                        Some(next) if next <= latest => {
                            count += 1;
                            cursor = next;
                        }
                        _ => break,
                    }
                }
                count
            }
        };
        Some(DueWindow {
            latest,
            earliest,
            count,
        })
    }

    /// The next `limit` occurrences strictly after `after`.
    pub(crate) fn upcoming(&self, after: i64, limit: usize) -> Vec<i64> {
        let mut out = Vec::with_capacity(limit);
        if let Rule::RRule { set } = &self.rule {
            let mut budget = RRULE_ITERATION_BUDGET;
            for occurrence in set {
                let at = occurrence.timestamp_millis();
                if at > after {
                    out.push(at);
                    if out.len() >= limit {
                        break;
                    }
                }
                budget -= 1;
                if budget == 0 {
                    break;
                }
            }
            return out;
        }
        let mut cursor = after;
        while out.len() < limit {
            match self.next_after(cursor) {
                Some(next) => {
                    out.push(next);
                    cursor = next;
                }
                None => break,
            }
        }
        out
    }

    fn day_occurrence(&self, anchor_local: NaiveDateTime, step: i64, k: i64) -> Option<i64> {
        let days = step.checked_mul(k)?;
        let local = anchor_local.checked_add_signed(Duration::try_days(days)?)?;
        Some(resolve_local(self.tz, local).timestamp_millis())
    }
}

fn interval_step_ms(value: u32, unit: IntervalUnit) -> i64 {
    let unit_ms = match unit {
        IntervalUnit::Minutes => MINUTE_MS,
        IntervalUnit::Hours => HOUR_MS,
        IntervalUnit::Days => 24 * HOUR_MS,
    };
    i64::from(value).saturating_mul(unit_ms)
}

/// Bring user RRULE text to exactly `DTSTART…\nRRULE:…`, anchored in a zone.
fn normalize_rrule_text(
    tz: Tz,
    text: &str,
    default_start: NaiveDateTime,
) -> Result<String, String> {
    let lines = text
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err("an RRULE schedule needs a rule such as 'FREQ=WEEKLY;BYDAY=MO'".to_string());
    }
    let mut dtstart: Option<String> = None;
    let mut rule: Option<String> = None;
    for line in lines {
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("DTSTART") {
            if dtstart.is_some() {
                return Err("an RRULE schedule takes one DTSTART line".to_string());
            }
            dtstart = Some(line.to_string());
        } else if let Some(body) = upper.strip_prefix("RRULE:") {
            if rule.is_some() {
                return Err("an RRULE schedule takes exactly one RRULE line".to_string());
            }
            rule = Some(body.trim().to_string());
        } else if upper.starts_with("FREQ=") || upper.contains(";FREQ=") {
            if rule.is_some() {
                return Err("an RRULE schedule takes exactly one RRULE line".to_string());
            }
            rule = Some(upper.trim().to_string());
        } else {
            return Err(format!(
                "unsupported line in RRULE text: '{line}' (only DTSTART and RRULE are accepted)"
            ));
        }
    }
    let rule = rule.ok_or_else(|| "RRULE text has a DTSTART but no RRULE line".to_string())?;
    let floating = |value: &str| -> Result<String, String> {
        let naive = NaiveDateTime::parse_from_str(value.trim(), "%Y%m%dT%H%M%S")
            .map_err(|_| format!("DTSTART '{value}' is not YYYYMMDDTHHMMSS"))?;
        Ok(anchored_dtstart(tz, naive))
    };
    let dtstart = match dtstart {
        None => anchored_dtstart(tz, default_start),
        Some(line) => {
            let (head, value) = line
                .split_once(':')
                .ok_or_else(|| format!("DTSTART line '{line}' has no value"))?;
            let head_upper = head.to_ascii_uppercase();
            if head_upper.contains("TZID=") || value.trim().ends_with(['Z', 'z']) {
                format!("{}:{}", head.trim(), value.trim().to_ascii_uppercase())
            } else if head_upper.trim() == "DTSTART" {
                floating(value)?
            } else {
                return Err(format!("unsupported DTSTART parameters in '{line}'"));
            }
        }
    };
    Ok(format!("{dtstart}\nRRULE:{rule}"))
}

fn anchored_dtstart(tz: Tz, naive: NaiveDateTime) -> String {
    let naive = truncate_to_minute(naive);
    if tz == Tz::UTC {
        format!("DTSTART:{}Z", naive.format("%Y%m%dT%H%M%S"))
    } else {
        format!("DTSTART;TZID={}:{}", tz.name(), naive.format("%Y%m%dT%H%M%S"))
    }
}

#[cfg(test)]
#[path = "../tests/scheduled/rules.rs"]
mod tests;
