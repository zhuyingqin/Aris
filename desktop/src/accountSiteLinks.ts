import { tr, type Language } from "./language";

// Password management lives on the SomniQ website, which owns the e-mail
// confirmation flow (the reset mail reveals a generated password the user can
// later change). The desktop app only deep-links there instead of re-implementing it.
const SITE_ORIGIN = "https://ensuanx.com";

export const siteLang = (language: Language) => tr(language, "zh", "en", "es");

export const changePasswordUrl = (language: Language) =>
  `${SITE_ORIGIN}/dashboard.html?tab=security&lang=${siteLang(language)}`;

export const forgotPasswordUrl = (language: Language) =>
  `${SITE_ORIGIN}/login.html?mode=forgot&lang=${siteLang(language)}`;
