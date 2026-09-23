import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

/** Every `.chat-scroll` block, in cascade order. The file declares the selector
 *  several times, and only the last one wins. */
function chatScrollBlocks(): string[] {
  return [...appStyles.matchAll(/(?:^|\n)\.chat-scroll\s*\{([^}]*)\}/g)].map((match) => match[1]);
}

describe("transcript scroll geometry", () => {
  it("leaves the transcript's vertical space to the virtualizer", () => {
    // The scroll container's own vertical padding is outside the virtual
    // coordinate space, so with it here `getTotalSize()` no longer equals this
    // box's `scrollHeight`: every offset the virtualizer computed was off by the
    // padding, and resizing the composer rewrote `scrollHeight` behind a viewport
    // the virtualizer believed it had anchored. `ChatThread` passes these insets
    // as `paddingStart` / `paddingEnd` instead.
    const winning = chatScrollBlocks().at(-1);
    expect(winning).toBeDefined();
    const padding = winning!.match(/(?:^|[;\s])padding:\s*([^;]+);/)?.[1]?.trim();
    expect(padding).toBe("0 24px");
    expect(winning).not.toMatch(/padding-top|padding-bottom|padding-block/);
  });

  it("keeps the browser's own scroll anchoring off", () => {
    // Deliberate: the virtualizer owns viewport compensation, and two anchors
    // fighting over one scroller is worse than one.
    expect(chatScrollBlocks().at(-1)).toMatch(/overflow-anchor:\s*none/);
  });

  it("reserves the question-rail gutter without waiting for a second question", () => {
    // Gating the gutter on `.has-question-timeline` meant it appeared the moment
    // a reader sent their second message, rewrapping every message and
    // invalidating every measured row height at once.
    expect(appStyles).toMatch(
      /\.chat-thread \.chat-scroll\s*\{[^}]*padding-inline:\s*clamp\(24px, calc\(992px - 100%\), 76px\);/s,
    );
    expect(appStyles).not.toMatch(/\.chat-thread\.has-question-timeline \.chat-scroll/);
  });

  it("keeps the transcript out from under an open project summary", () => {
    // The summary is an overlay at desktop widths. Its selector must be at
    // least as specific as the question-rail gutter declared later in the
    // stylesheet, otherwise `padding-inline` silently resets the reservation.
    expect(appStyles).toMatch(
      /\.chat-root\.chat-project-brief-open \.chat-thread \.chat-scroll\s*\{[^}]*padding-left:\s*76px;[^}]*padding-right:\s*calc\(var\(--project-brief-lane-w\) \+ 38px\);/s,
    );
  });

  it("restores symmetric transcript gutters when the summary stacks on mobile", () => {
    expect(appStyles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.chat-root\.chat-project-brief-open \.chat-thread \.chat-scroll\s*\{[^}]*padding-inline:\s*12px;/,
    );
  });

  it("gives the no-transcript states their own vertical padding", () => {
    // `.chat-welcome` and the loading state are not virtualized, so they cannot
    // rely on the insets `ChatThread` hands to the virtualizer.
    expect(appStyles).toMatch(/\.chat-welcome\s*\{[^}]*padding:\s*26px 0 20px;/s);
    expect(appStyles).toMatch(/\.chat-thread-loading\s*\{[^}]*padding:\s*40px 0;/s);
  });
});
