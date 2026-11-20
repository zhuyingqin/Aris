//! The UI language for messages the backend shows verbatim.
//!
//! The desktop writes the user's choice to config `language`, and every config
//! save re-exports it as `ARIS_LANGUAGE` in this process (see the desktop's
//! `apply_reviewer_environment_from`), so reading the environment on each call
//! follows a change made in Settings without a restart.
//!
//! Unknown or empty values keep the historical Chinese default. Model prompts,
//! keyword lists and log lines are not UI text and must not go through here.

use std::cell::Cell;

/// Environment variable carrying the UI language: `cn`, `en` or `es`.
pub const UI_LANGUAGE_ENV: &str = "ARIS_LANGUAGE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLanguage {
    Cn,
    En,
    Es,
}

impl UiLanguage {
    /// Parse a language code. `zh*` reads as Chinese, `en*` and `es*` by prefix;
    /// anything else is `None`.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim().to_ascii_lowercase();
        if value == "cn" || value.starts_with("zh") {
            Some(Self::Cn)
        } else if value.starts_with("en") {
            Some(Self::En)
        } else if value.starts_with("es") {
            Some(Self::Es)
        } else {
            None
        }
    }

    /// Pick the copy for this language.
    #[must_use]
    pub fn pick<'a>(self, cn: &'a str, en: &'a str, es: &'a str) -> &'a str {
        match self {
            Self::Cn => cn,
            Self::En => en,
            Self::Es => es,
        }
    }
}

thread_local! {
    static OVERRIDE: Cell<Option<UiLanguage>> = const { Cell::new(None) };
}

/// The current UI language. A [`scoped`] override on this thread wins over the
/// environment; unknown or missing values fall back to Chinese.
#[must_use]
pub fn ui_language() -> UiLanguage {
    if let Some(language) = OVERRIDE.with(Cell::get) {
        return language;
    }
    std::env::var(UI_LANGUAGE_ENV)
        .ok()
        .and_then(|value| UiLanguage::parse(&value))
        .unwrap_or(UiLanguage::Cn)
}

/// The copy for the current UI language.
#[must_use]
pub fn tr(cn: &str, en: &str, es: &str) -> String {
    ui_language().pick(cn, en, es).to_owned()
}

/// Like [`tr`] without allocating, for `&'static str` call sites.
#[must_use]
pub fn tr_static(cn: &'static str, en: &'static str, es: &'static str) -> &'static str {
    ui_language().pick(cn, en, es)
}

/// Restores the previous thread-local override on drop.
pub struct ScopedUiLanguage {
    previous: Option<UiLanguage>,
}

impl Drop for ScopedUiLanguage {
    fn drop(&mut self) {
        let previous = self.previous;
        OVERRIDE.with(|cell| cell.set(previous));
    }
}

/// Pin the UI language on this thread until the guard drops. Tests use it so
/// assertions on message text never depend on the process environment.
#[must_use]
pub fn scoped(language: UiLanguage) -> ScopedUiLanguage {
    let previous = OVERRIDE.with(|cell| cell.replace(Some(language)));
    ScopedUiLanguage { previous }
}

/// `tr!("中文 {x}", "English {x}", "Español {x}")`: [`tr`] with `format!`
/// arguments. Only the chosen language's string is formatted; all three must
/// use the same arguments (inline captures are the simplest).
#[macro_export]
macro_rules! tr {
    ($cn:literal, $en:literal, $es:literal $(,)?) => {
        match $crate::ui_lang::ui_language() {
            $crate::ui_lang::UiLanguage::Cn => ::std::format!($cn),
            $crate::ui_lang::UiLanguage::En => ::std::format!($en),
            $crate::ui_lang::UiLanguage::Es => ::std::format!($es),
        }
    };
    ($cn:literal, $en:literal, $es:literal, $($arg:tt)+) => {
        match $crate::ui_lang::ui_language() {
            $crate::ui_lang::UiLanguage::Cn => ::std::format!($cn, $($arg)+),
            $crate::ui_lang::UiLanguage::En => ::std::format!($en, $($arg)+),
            $crate::ui_lang::UiLanguage::Es => ::std::format!($es, $($arg)+),
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_codes_and_rejects_unknown_ones() {
        assert_eq!(UiLanguage::parse("cn"), Some(UiLanguage::Cn));
        assert_eq!(UiLanguage::parse("zh-CN"), Some(UiLanguage::Cn));
        assert_eq!(UiLanguage::parse(" EN "), Some(UiLanguage::En));
        assert_eq!(UiLanguage::parse("es-ES"), Some(UiLanguage::Es));
        assert_eq!(UiLanguage::parse("fr"), None);
        assert_eq!(UiLanguage::parse(""), None);
    }

    #[test]
    fn scoped_override_picks_the_copy_and_formats_arguments() {
        let value = 3;
        {
            let _guard = scoped(UiLanguage::Es);
            assert_eq!(tr("中", "en", "es"), "es");
            assert_eq!(crate::tr!("{} 个", "{} items", "{} elementos", value), "3 elementos");
            {
                let _inner = scoped(UiLanguage::En);
                assert_eq!(tr_static("中", "en", "es"), "en");
            }
            assert_eq!(tr_static("中", "en", "es"), "es");
        }
        let _guard = scoped(UiLanguage::Cn);
        assert_eq!(crate::tr!("{value} 个", "{value} items", "{value} elementos"), "3 个");
    }
}
