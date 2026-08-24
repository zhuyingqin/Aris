import { useCallback, useEffect, useState } from "react";
import { COPY, detectTheme, persistTheme, useAutoLang, type Theme } from "./i18n";
import { AuthProvider } from "./context/AuthContext";
import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Does from "./components/Does";
import Review from "./components/Review";
import Benchmark from "./components/Benchmark";
import Memory from "./components/Memory";
import Vision from "./components/Vision";
import Footer from "./components/Footer";
import AuthModal from "./components/AuthModal";
import UserDashboard from "./components/UserDashboard";
import PwaInstallBanner from "./components/PwaInstallBanner";
import { useReveal } from "./useReveal";

export default function App() {
  const [lang, setLang] = useAutoLang();
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const copy = COPY[lang];

  useEffect(() => {
    document.documentElement.lang = copy.htmlLang;
    document.title = copy.docTitle;
  }, [copy.htmlLang, copy.docTitle]);

  useEffect(() => {
    persistTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Listen to browser/OS theme changes dynamically
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e: MediaQueryListEvent) => {
      const stored = window.localStorage.getItem("somniq-site-theme");
      if (!stored) {
        setTheme(e.matches ? "light" : "dark");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggleLang = useCallback(() => {
    setLang((current) => (current === "zh" ? "en" : current === "en" ? "es" : "zh"));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  // Re-run on language change: swapping copy replaces the observed nodes.
  useReveal([lang]);

  return (
    <AuthProvider>
      <div className={`page lang-${lang} theme-${theme}`}>
        <div className="aurora" aria-hidden="true">
          <span className="aurora-blob aurora-blob--blue" />
          <span className="aurora-blob aurora-blob--violet" />
          <span className="aurora-grid" />
        </div>

        <PwaInstallBanner copy={copy} />
        <Nav
          copy={copy}
          theme={theme}
          currentLang={lang}
          onSelectLang={setLang}
          onToggleLang={toggleLang}
          onToggleTheme={toggleTheme}
        />

        <main id="main">
          <Hero copy={copy} />
          <Does copy={copy} />
          <Review copy={copy} />
          <Benchmark copy={copy} />
          <Memory copy={copy} />
          <Vision copy={copy} />
        </main>

        <Footer copy={copy} />

        <AuthModal copy={copy} />
        <UserDashboard copy={copy} />
      </div>
    </AuthProvider>
  );
}
