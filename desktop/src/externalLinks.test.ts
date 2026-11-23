// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "./api/tauri";
import { installExternalLinkRouting } from "./externalLinks";

vi.mock("./api/tauri", () => ({
  isTauri: () => true,
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

function anchor(href: string, extra: (element: HTMLAnchorElement) => void = () => undefined) {
  const element = document.createElement("a");
  element.setAttribute("href", href);
  element.target = "_blank";
  element.innerHTML = "<span>link</span>";
  extra(element);
  document.body.appendChild(element);
  return element;
}

function click(element: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent(init.button === 1 ? "auxclick" : "click", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

describe("installExternalLinkRouting", () => {
  let uninstall: () => void;
  beforeEach(() => {
    vi.mocked(openExternalUrl).mockClear();
    uninstall = installExternalLinkRouting();
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  it("opens an external link from a nested child in the system browser", () => {
    const link = anchor("https://arxiv.org/abs/1706.03762");
    const event = click(link.querySelector("span")!);
    expect(event.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith("https://arxiv.org/abs/1706.03762");
  });

  it("routes middle clicks and mailto links too", () => {
    click(anchor("mailto:someone@example.com"), { button: 1 });
    expect(openExternalUrl).toHaveBeenCalledWith("mailto:someone@example.com");
  });

  it("leaves clicks a component already handled, local files, and same-origin links alone", () => {
    const local = anchor("F:/papers/a.pdf");
    const handled = anchor("https://example.com/");
    handled.addEventListener("click", (event) => event.preventDefault());
    const sameOrigin = anchor(`${window.location.origin}/settings`);
    click(local);
    click(handled);
    click(sameOrigin);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
