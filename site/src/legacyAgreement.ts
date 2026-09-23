// Preserve old bookmarks without maintaining a second agreement.
const destination = new URL("./user-service-agreement.html", window.location.href);
const lang = new URLSearchParams(window.location.search).get("lang");
if (lang === "zh" || lang === "en" || lang === "es") destination.searchParams.set("lang", lang);
destination.hash = "legal-auto-renewal";
const link = document.getElementById("agreement-link");
if (link instanceof HTMLAnchorElement) link.href = destination.href;
window.location.replace(destination.href);
