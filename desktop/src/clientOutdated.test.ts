// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { isClientOutdatedError, onClientOutdated, reportClientOutdated } from "./clientOutdated";
import { formatUserFacingError } from "./errorMessage";

// The forms `runtime::client_outdated_error` and the Anthropic client produce
// for a 426 from the SomniQ edge.
const ACCOUNT_ERROR = "SomniQ Studio 版本过旧，请在 设置 → 更新 中升级到 0.4.86 或更高版本 (client_outdated)";
const ANTHROPIC_ERROR = "anthropic api returned 426 Upgrade Required (client_outdated): SomniQ Studio 版本过旧";

describe("client outdated errors", () => {
  it("recognizes every surfaced form and nothing else", () => {
    expect(isClientOutdatedError(ACCOUNT_ERROR)).toBe(true);
    expect(isClientOutdatedError(new Error(ANTHROPIC_ERROR))).toBe(true);
    expect(isClientOutdatedError("HTTP 400 Bad Request")).toBe(false);
    expect(isClientOutdatedError(null)).toBe(false);
  });

  it("asks for the update instead of a generic failure", () => {
    expect(formatUserFacingError(ACCOUNT_ERROR)).toBe("当前版本已停止服务，请更新 SomniQ Studio 后继续使用。");
    expect(formatUserFacingError(ANTHROPIC_ERROR, "en")).toBe(
      "This version of SomniQ Studio is no longer supported. Update it to continue.",
    );
  });

  it("broadcasts only refusals", () => {
    const handler = vi.fn();
    const unsubscribe = onClientOutdated(handler);
    reportClientOutdated("connection refused");
    expect(handler).not.toHaveBeenCalled();
    reportClientOutdated(ACCOUNT_ERROR);
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    reportClientOutdated(ACCOUNT_ERROR);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
