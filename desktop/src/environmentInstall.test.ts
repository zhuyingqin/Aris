import { beforeEach, describe, expect, it } from "vitest";
import {
  environmentInstallPrompt,
  handoffEnvironmentInstall,
  type InstallableEnvironmentId,
} from "./environmentInstall";
import { useStore } from "./store";

const RUNTIMES: InstallableEnvironmentId[] = ["python", "jupyter", "latex"];

beforeEach(() => {
  useStore.setState({ tab: "settings", pendingChatInput: null, pendingChatRunInput: null, language: "en" });
});

describe("environment installation handoff", () => {
  it.each(RUNTIMES)("provides Chinese and English reviewable prompts for %s", (runtime) => {
    expect(environmentInstallPrompt(runtime, "cn").length).toBeGreaterThan(80);
    expect(environmentInstallPrompt(runtime, "en")).toContain("ask for my approval");
  });

  it("opens Chat with the selected runtime request without sending it", () => {
    handoffEnvironmentInstall("jupyter", "en");

    expect(useStore.getState().tab).toBe("chat");
    expect(useStore.getState().pendingChatInput).toContain("JupyterLab");
    expect(useStore.getState().pendingChatRunInput).toBeNull();
  });
});
