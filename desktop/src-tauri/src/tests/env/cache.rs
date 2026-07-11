use super::*;

#[test]
fn expired_cache_returns_true() {
    // A cache checked 8 days ago should be expired with 7-day TTL.
    let ago = current_unix_secs() - 8 * 86400;
    let ts = {
        let days_since_epoch = ago / 86400;
        let remaining = ago % 86400;
        let hour = remaining / 3600;
        let min = (remaining % 3600) / 60;
        let sec = remaining % 60;
        let mut y = 1970;
        let mut d = days_since_epoch;
        loop {
            let days_in_year = if is_leap(y) { 366 } else { 365 };
            if d < days_in_year {
                break;
            }
            d -= days_in_year;
            y += 1;
        }
        let month_days = if is_leap(y) {
            [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        } else {
            [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        };
        let mut m = 1;
        for &md in &month_days {
            if d < md {
                break;
            }
            d -= md;
            m += 1;
        }
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            y,
            m,
            d + 1,
            hour,
            min,
            sec
        )
    };
    assert!(is_expired(&ts, 7));
}

#[test]
fn fresh_cache_returns_false() {
    let ts = chrono_now();
    assert!(!is_expired(&ts, 7));
}
