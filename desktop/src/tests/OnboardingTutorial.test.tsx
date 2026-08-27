// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OnboardingTutorial, { ONBOARDING_STORAGE_KEY } from "../OnboardingTutorial";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("OnboardingTutorial", () => {
  it("shows component-level guidance for first-time users", () => {
    render(<OnboardingTutorial />);

    expect(screen.getByRole("dialog", { name: /左上角菜单/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "跳过" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一步" })).toBeTruthy();
  });

  it("persists the seen flag when skipped", async () => {
    const user = userEvent.setup();
    render(<OnboardingTutorial />);

    await user.click(screen.getByRole("button", { name: "跳过" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
  });

  it("does not show again after completion", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");

    render(<OnboardingTutorial />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not interrupt users with existing local app state", () => {
    localStorage.setItem("aris-chat-current-id", "chat-existing");

    render(<OnboardingTutorial />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
  });

  it("closes and persists after the final step", async () => {
    const user = userEvent.setup();
    render(<OnboardingTutorial />);

    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "开始使用" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
  });

  it("can return to the previous tutorial step", async () => {
    const user = userEvent.setup();
    render(<OnboardingTutorial />);

    const previousButton = screen.getByRole("button", { name: "上一步" }) as HTMLButtonElement;
    expect(previousButton.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByRole("dialog", { name: /Chat：把研究任务交给代理/ })).toBeTruthy();
    expect(previousButton.disabled).toBe(false);

    await user.click(previousButton);

    expect(screen.getByRole("dialog", { name: /左上角菜单/ })).toBeTruthy();
  });

  it("supports left-arrow navigation", async () => {
    const user = userEvent.setup();
    render(<OnboardingTutorial />);

    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("dialog", { name: /左上角菜单/ })).toBeTruthy();
  });
});
