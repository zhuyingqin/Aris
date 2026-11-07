//! Rule expansion: zones, DST gaps and folds, counting missed occurrences.
//!
//! Every expected instant is written in UTC so the test states what the rule
//! *means*, not what the implementation happened to compute. The DST dates
//! are 2026's: US spring-forward 8 March, fall-back 1 November; EU
//! spring-forward 29 March; Lord Howe (a 30-minute shift) 4 October.

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use super::{
    parse_local, parse_time_zone, resolve_local, IntervalUnit, Schedule, MISSED_COUNT_CAP,
};

const NEW_YORK: Tz = chrono_tz::America::New_York;
const SHANGHAI: Tz = chrono_tz::Asia::Shanghai;
const BERLIN: Tz = chrono_tz::Europe::Berlin;
const KOLKATA: Tz = chrono_tz::Asia::Kolkata;
const LORD_HOWE: Tz = chrono_tz::Australia::Lord_Howe;

fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()
        .expect("valid UTC")
        .timestamp_millis()
}

fn naive(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(year, month, day)
        .and_then(|date| date.and_hms_opt(hour, minute, 0))
        .expect("valid naive")
}

fn next_n(schedule: &Schedule, after: i64, n: usize) -> Vec<i64> {
    schedule.upcoming(after, n)
}

#[test]
fn zones_must_be_explicit_iana_names() {
    assert_eq!(parse_time_zone("Asia/Shanghai").unwrap(), SHANGHAI);
    assert_eq!(parse_time_zone(" America/New_York ").unwrap(), NEW_YORK);
    assert!(parse_time_zone("").is_err(), "an empty zone is not a default");
    assert!(parse_time_zone("CST+8").is_err());
    assert!(parse_time_zone("Mars/Olympus_Mons").is_err());
}

#[test]
fn local_input_parses_at_minute_granularity() {
    assert_eq!(parse_local("2026-03-08T02:30").unwrap(), naive(2026, 3, 8, 2, 30));
    assert_eq!(parse_local("2026-03-08T02:30:59").unwrap(), naive(2026, 3, 8, 2, 30));
    assert!(parse_local("tomorrow at nine").is_err());
}

/// RFC 5545 §3.3.5: a wall-clock time inside a gap is read with the offset
/// before the gap; one inside a fold is the first of the two.
#[test]
fn wall_clock_times_resolve_through_gaps_and_folds() {
    // 02:30 does not exist in New York on 8 March: 03:30 EDT.
    assert_eq!(
        resolve_local(NEW_YORK, naive(2026, 3, 8, 2, 30)).timestamp_millis(),
        utc(2026, 3, 8, 7, 30)
    );
    // 01:30 happens twice on 1 November: the EDT one.
    assert_eq!(
        resolve_local(NEW_YORK, naive(2026, 11, 1, 1, 30)).timestamp_millis(),
        utc(2026, 11, 1, 5, 30)
    );
    // A 30-minute gap moves a time by 30 minutes, not an hour: 02:15 on Lord
    // Howe's spring-forward day is 02:45 (UTC+11).
    assert_eq!(
        resolve_local(LORD_HOWE, naive(2026, 10, 4, 2, 15)).timestamp_millis(),
        utc(2026, 10, 3, 15, 45)
    );
    // Ordinary times are untouched, half-hour zones included.
    assert_eq!(
        resolve_local(KOLKATA, naive(2026, 6, 1, 9, 0)).timestamp_millis(),
        utc(2026, 6, 1, 3, 30)
    );
}

#[test]
fn a_one_shot_fires_once_and_then_has_nothing() {
    let at = utc(2026, 11, 7, 1, 0);
    let schedule = Schedule::once(SHANGHAI, at);
    assert_eq!(schedule.next_after(at - 1), Some(at));
    assert_eq!(schedule.next_after(at), None);
    let window = schedule.due_window(at, at + 3_600_000).expect("due");
    assert_eq!((window.latest, window.count), (at, 1));
    assert!(schedule.due_window(at + 1, at + 3_600_000).is_none());
}

#[test]
fn cron_runs_weekdays_at_nine_in_its_own_zone() {
    let schedule = Schedule::cron(SHANGHAI, "0 9 * * 1-5").expect("cron");
    // Friday 6 November 2026, 10:00 Shanghai → next is Monday 9 November.
    let friday_after_nine = utc(2026, 11, 6, 2, 0);
    assert_eq!(
        next_n(&schedule, friday_after_nine, 3),
        vec![
            utc(2026, 11, 9, 1, 0),
            utc(2026, 11, 10, 1, 0),
            utc(2026, 11, 11, 1, 0),
        ]
    );
    // The same expression in another zone is a different instant.
    let berlin = Schedule::cron(BERLIN, "0 9 * * 1-5").expect("cron");
    assert_eq!(berlin.next_after(friday_after_nine), Some(utc(2026, 11, 6, 8, 0)));
}

#[test]
fn cron_rejects_what_it_cannot_honour() {
    assert!(Schedule::cron(SHANGHAI, "").is_err());
    assert!(Schedule::cron(SHANGHAI, "0 0 9 * * 1").is_err(), "no seconds field");
    assert!(Schedule::cron(SHANGHAI, "61 * * * *").is_err());
    assert!(Schedule::cron(SHANGHAI, "* * *").is_err());
}

/// Vixie cron: a fixed-time job whose minute falls in the gap still runs
/// that day, right after the gap — once.
#[test]
fn a_fixed_time_cron_job_in_a_dst_gap_runs_once_after_the_gap() {
    let schedule = Schedule::cron(NEW_YORK, "30 2 * * *").expect("cron");
    let runs = next_n(&schedule, utc(2026, 3, 7, 12, 0), 3);
    assert_eq!(runs[0], utc(2026, 3, 8, 7, 0), "03:00 EDT, right after the gap");
    assert_eq!(runs[1], utc(2026, 3, 9, 6, 30), "02:30 EDT the next day");
    assert_eq!(runs[2], utc(2026, 3, 10, 6, 30));
}

/// Vixie cron: a fixed-time job in a repeated hour runs on the first pass
/// only; a step job runs on both.
#[test]
fn cron_in_a_dst_fold_runs_fixed_jobs_once_and_step_jobs_twice() {
    let fixed = Schedule::cron(NEW_YORK, "30 1 * * *").expect("cron");
    assert_eq!(
        next_n(&fixed, utc(2026, 10, 31, 12, 0), 2),
        vec![utc(2026, 11, 1, 5, 30), utc(2026, 11, 2, 6, 30)],
        "01:30 EDT on the fold day, then 01:30 EST"
    );

    let stepped = Schedule::cron(NEW_YORK, "*/30 1 * * *").expect("cron");
    assert_eq!(
        next_n(&stepped, utc(2026, 10, 31, 12, 0), 4),
        vec![
            utc(2026, 11, 1, 5, 0),  // 01:00 EDT
            utc(2026, 11, 1, 5, 30), // 01:30 EDT
            utc(2026, 11, 1, 6, 0),  // 01:00 EST
            utc(2026, 11, 1, 6, 30), // 01:30 EST
        ]
    );
}

#[test]
fn rrule_keeps_its_wall_clock_across_a_dst_change() {
    let (schedule, text) = Schedule::rrule(
        BERLIN,
        "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        naive(2026, 3, 27, 9, 0),
    )
    .expect("rrule");
    assert_eq!(
        text,
        "DTSTART;TZID=Europe/Berlin:20260327T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
    );
    assert_eq!(
        next_n(&schedule, utc(2026, 3, 27, 0, 0), 4),
        vec![
            utc(2026, 3, 27, 8, 0), // CET
            utc(2026, 3, 28, 8, 0),
            utc(2026, 3, 29, 7, 0), // CEST from here
            utc(2026, 3, 30, 7, 0),
        ]
    );
}

#[test]
fn rrule_occurrences_in_a_gap_shift_forward_and_in_a_fold_happen_once() {
    let (gap, _) = Schedule::rrule(NEW_YORK, "RRULE:FREQ=DAILY", naive(2026, 3, 7, 2, 30))
        .expect("rrule");
    assert_eq!(
        next_n(&gap, utc(2026, 3, 7, 0, 0), 3),
        vec![
            utc(2026, 3, 7, 7, 30), // 02:30 EST
            utc(2026, 3, 8, 7, 30), // no 02:30 that day: 03:30 EDT
            utc(2026, 3, 9, 6, 30), // 02:30 EDT
        ]
    );

    let (fold, _) = Schedule::rrule(NEW_YORK, "FREQ=DAILY", naive(2026, 10, 31, 1, 30))
        .expect("rrule");
    assert_eq!(
        next_n(&fold, utc(2026, 10, 31, 0, 0), 3),
        vec![
            utc(2026, 10, 31, 5, 30), // 01:30 EDT
            utc(2026, 11, 1, 5, 30),  // the first 01:30 only
            utc(2026, 11, 2, 6, 30),  // 01:30 EST
        ]
    );
}

#[test]
fn rrule_dtstart_with_its_own_zone_wins_and_count_ends_the_rule() {
    let (schedule, text) = Schedule::rrule(
        SHANGHAI,
        "DTSTART;TZID=America/New_York:20260105T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2",
        naive(2000, 1, 1, 0, 0),
    )
    .expect("rrule");
    assert_eq!(schedule.time_zone(), NEW_YORK);
    assert!(text.starts_with("DTSTART;TZID=America/New_York:20260105T090000\n"));
    let runs = next_n(&schedule, utc(2026, 1, 1, 0, 0), 5);
    assert_eq!(runs, vec![utc(2026, 1, 5, 14, 0), utc(2026, 1, 12, 14, 0)]);
    assert_eq!(schedule.next_after(utc(2026, 1, 12, 14, 0)), None, "COUNT exhausted");

    // A floating DTSTART is anchored in the task's zone, never the machine's.
    let (_, anchored) = Schedule::rrule(
        SHANGHAI,
        "DTSTART:20260105T090000\nRRULE:FREQ=DAILY",
        naive(2000, 1, 1, 0, 0),
    )
    .expect("rrule");
    assert!(anchored.starts_with("DTSTART;TZID=Asia/Shanghai:20260105T090000"));
}

#[test]
fn rrule_profile_is_bounded() {
    let start = naive(2026, 1, 1, 9, 0);
    assert!(Schedule::rrule(SHANGHAI, "FREQ=MINUTELY", start).is_err());
    assert!(Schedule::rrule(SHANGHAI, "FREQ=SECONDLY", start).is_err());
    assert!(Schedule::rrule(SHANGHAI, "", start).is_err());
    assert!(Schedule::rrule(SHANGHAI, "RRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY", start).is_err());
    assert!(Schedule::rrule(SHANGHAI, "EXDATE:20260102T090000", start).is_err());
    assert!(Schedule::rrule(SHANGHAI, "FREQ=FORTNIGHTLY", start).is_err());
}

/// Hour intervals are elapsed time: six real hours apart even across the
/// night the clocks change.
#[test]
fn hour_intervals_are_elapsed_time_across_dst() {
    let anchor = utc(2026, 3, 7, 23, 0);
    let schedule =
        Schedule::interval(NEW_YORK, 6, IntervalUnit::Hours, anchor, None).expect("interval");
    assert_eq!(
        next_n(&schedule, anchor - 1, 4),
        vec![
            anchor,
            anchor + 6 * 3_600_000,
            anchor + 12 * 3_600_000,
            anchor + 18 * 3_600_000,
        ]
    );
}

/// Day intervals are calendar days: 09:00 stays 09:00 on the wall clock, so
/// the instant moves by an hour when the zone does.
#[test]
fn day_intervals_keep_the_wall_clock_across_dst() {
    let start = naive(2026, 3, 7, 9, 0);
    let anchor = resolve_local(NEW_YORK, start).timestamp_millis();
    let schedule = Schedule::interval(NEW_YORK, 1, IntervalUnit::Days, anchor, Some(start))
        .expect("interval");
    assert_eq!(
        next_n(&schedule, anchor - 1, 3),
        vec![
            utc(2026, 3, 7, 14, 0), // 09:00 EST
            utc(2026, 3, 8, 13, 0), // 09:00 EDT
            utc(2026, 3, 9, 13, 0),
        ]
    );
    // And the latest-before search agrees with the forward one.
    assert_eq!(
        schedule.latest_at_or_before(utc(2026, 3, 8, 20, 0)),
        Some(utc(2026, 3, 8, 13, 0))
    );
    // A day-interval whose wall clock lands in a gap that day runs after it.
    let night = naive(2026, 3, 7, 2, 30);
    let night_schedule = Schedule::interval(
        NEW_YORK,
        1,
        IntervalUnit::Days,
        resolve_local(NEW_YORK, night).timestamp_millis(),
        Some(night),
    )
    .expect("interval");
    assert_eq!(
        next_n(&night_schedule, utc(2026, 3, 7, 0, 0), 3),
        vec![utc(2026, 3, 7, 7, 30), utc(2026, 3, 8, 7, 30), utc(2026, 3, 9, 6, 30)]
    );
}

/// The window a dispatcher folds after downtime: latest occurrence plus how
/// many there were, for every rule kind.
#[test]
fn due_windows_fold_missed_occurrences_into_the_latest() {
    // Every 15 minutes, three hours offline: twelve occurrences.
    let anchor = utc(2026, 6, 1, 0, 0);
    let interval =
        Schedule::interval(SHANGHAI, 15, IntervalUnit::Minutes, anchor, None).expect("interval");
    let window = interval
        .due_window(anchor, anchor + 3 * 3_600_000 - 1)
        .expect("due");
    assert_eq!(window.count, 12);
    assert_eq!(window.earliest, anchor);
    assert_eq!(window.latest, anchor + 165 * 60_000);

    // Cron across a weekend: Friday 09:00 → Monday 10:00 holds Fri and Mon.
    let cron = Schedule::cron(SHANGHAI, "0 9 * * 1-5").expect("cron");
    let window = cron
        .due_window(utc(2026, 11, 6, 1, 0), utc(2026, 11, 9, 2, 0))
        .expect("due");
    assert_eq!(
        (window.earliest, window.latest, window.count),
        (utc(2026, 11, 6, 1, 0), utc(2026, 11, 9, 1, 0), 2)
    );

    // RRULE over a week of dailies.
    let (rrule, _) =
        Schedule::rrule(SHANGHAI, "FREQ=DAILY", naive(2026, 6, 1, 9, 0)).expect("rrule");
    let window = rrule
        .due_window(utc(2026, 6, 1, 1, 0), utc(2026, 6, 7, 12, 0))
        .expect("due");
    assert_eq!((window.latest, window.count), (utc(2026, 6, 7, 1, 0), 7));

    // Nothing due before the first occurrence.
    assert!(cron
        .due_window(utc(2026, 11, 7, 1, 0), utc(2026, 11, 8, 23, 0))
        .is_none());
}

/// A minutely interval left off for a month must not make the tick count to
/// forty thousand.
#[test]
fn missed_counts_saturate_instead_of_walking_forever() {
    let anchor = utc(2026, 1, 1, 0, 0);
    let interval =
        Schedule::interval(SHANGHAI, 1, IntervalUnit::Minutes, anchor, None).expect("interval");
    let window = interval
        .due_window(anchor, anchor + 30 * 24 * 3_600_000)
        .expect("due");
    assert_eq!(window.count, MISSED_COUNT_CAP);
    assert_eq!(window.latest, anchor + 30 * 24 * 3_600_000);

    let cron = Schedule::cron(SHANGHAI, "* * * * *").expect("cron");
    let window = cron
        .due_window(anchor, anchor + 30 * 24 * 3_600_000)
        .expect("due");
    assert_eq!(window.count, MISSED_COUNT_CAP);
    assert_eq!(window.latest, anchor + 30 * 24 * 3_600_000);
}
