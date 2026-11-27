// The "SomniQ is controlling this computer" pill (control-indicator.html) and,
// with `?border=1`, the red frame drawn around the window being read.
// Plain DOM on purpose: it is shown on every monitor at once and must not
// load the workspace bundle. The Rust side (computer_control.rs) creates,
// moves and destroys these windows; this page only renders and asks to stop.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { indicatorCopy, formatElapsed, type ControlStatus } from "./indicatorCopy";

if (new URLSearchParams(window.location.search).has("border")) {
  // The frame is pure decoration: click-through and fixed by the backend.
  document.body.classList.add("border-mode");
} else {
  const text = document.getElementById("text")!;
  const elapsed = document.getElementById("elapsed")!;
  const stop = document.getElementById("stop") as HTMLButtonElement;
  let status: ControlStatus | null = null;

  const render = () => {
    if (!status) return;
    const copy = indicatorCopy(status.language, status.sessionIds.length, status.observing?.title ?? null);
    document.documentElement.lang = copy.htmlLang;
    text.textContent = copy.title;
    text.title = copy.tooltip;
    stop.textContent = stop.disabled ? copy.stopping : copy.stop;
    stop.title = copy.stopTitle;
    elapsed.textContent = status.sinceMs ? formatElapsed(Date.now() - status.sinceMs) : "";
  };

  const apply = (next: ControlStatus) => {
    status = next;
    // A new controlling turn re-arms the button after an earlier stop.
    if (next.active) stop.disabled = false;
    render();
  };

  stop.addEventListener("click", () => {
    stop.disabled = true;
    render();
    invoke<number>("computer_control_stop").catch(() => {
      stop.disabled = false;
      render();
    });
  });

  void listen<ControlStatus>("computer-control-changed", (event) => apply(event.payload));
  invoke<ControlStatus>("computer_control_status").then(apply).catch(() => undefined);
  window.setInterval(render, 1000);
}
