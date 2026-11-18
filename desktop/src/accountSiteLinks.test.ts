import { describe, expect, it } from "vitest";
import { changePasswordUrl, forgotPasswordUrl } from "./accountSiteLinks";

describe("account site links", () => {
  it("points password management at the website in the UI language", () => {
    expect(changePasswordUrl("cn")).toBe("https://ensuanx.com/dashboard.html?tab=security&lang=zh");
    expect(changePasswordUrl("en")).toBe("https://ensuanx.com/dashboard.html?tab=security&lang=en");
    expect(forgotPasswordUrl("cn")).toBe("https://ensuanx.com/login.html?mode=forgot&lang=zh");
    expect(forgotPasswordUrl("en")).toBe("https://ensuanx.com/login.html?mode=forgot&lang=en");
  });
});
