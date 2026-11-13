import { describe, expect, it } from "vitest";

import { describeScheduledError } from "./errorText";

describe("describeScheduledError", () => {
  it("explains a missing Git install in the user's language", () => {
    const raw =
      "Git is not installed or is not available on PATH. Work tasks and scheduled tasks use Git to keep their changes in an isolated copy until you accept them; install Git (https://git-scm.com) and try again";
    expect(describeScheduledError(raw, "cn")).toContain("没有安装 Git");
    expect(describeScheduledError(raw, "en")).toContain("Git is not installed");
  });

  it("tells users of older builds that plain folders now work", () => {
    // The exact sentence 0.4.68–0.4.86 wrote into lastError and the history.
    const legacy =
      "work tasks need a Git repository: this project is not one, so there is no branch to isolate the work on";
    expect(describeScheduledError(legacy, "cn")).toContain("新版本已支持普通文件夹");
  });

  it("explains an oversized folder and a vanished project", () => {
    expect(
      describeScheduledError(
        "this project folder is too large to copy into an isolated task checkout: more than 50000 files",
        "cn",
      ),
    ).toContain("项目文件夹太大");
    expect(
      describeScheduledError(
        "this task would run in project 'project-0123456789abcdef', which is not in SomniQ's project list any more, so there is nowhere to run it",
        "cn",
      ),
    ).toContain("不在 SomniQ 的项目列表");
  });

  it("explains the busy hold", () => {
    expect(
      describeScheduledError("waiting for work task 19a0-0001 (running) to finish before the next run", "cn"),
    ).toContain("上一次运行还没结束");
  });

  it("passes anything else through untouched", () => {
    expect(describeScheduledError("model returned 502", "cn")).toBe("model returned 502");
    expect(describeScheduledError(null, "cn")).toBe("");
    expect(describeScheduledError("   ", "en")).toBe("");
  });
});
