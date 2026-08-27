// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LanguageChoice from "./LanguageChoice";
import Login from "./Login";
import { DEFAULT_AUTH_SERVER, useStore } from "../store";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    newapiAuthStatus: vi.fn().mockResolvedValue({
      registerEnabled: false,
      passwordRegisterEnabled: false,
      passwordLoginEnabled: true,
      emailVerification: false,
      turnstileCheck: false,
      turnstileSiteKey: "",
      userAgreementEnabled: false,
      privacyPolicyEnabled: false,
    }),
  };
});

const initialLanguage = useStore.getState().language;
const initialPreferenceSet = useStore.getState().languagePreferenceSet;

describe("Login and first-entry workspace choice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useStore.setState({
      authServer: DEFAULT_AUTH_SERVER,
      language: "en",
      languagePreferenceSet: false,
      theme: "dark",
      themePreferenceSet: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("shows a fresh profile the English login form without silently saving a choice", () => {
    expect(initialLanguage).toBe("en");
    expect(initialPreferenceSet).toBe(false);

    render(<Login />);

    expect(screen.queryByRole("heading", { name: "Choose your language" })).toBeNull();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Username")).toBeTruthy();
    expect(localStorage.getItem("somniq-ui-language")).toBeNull();
  });

  it("persists English from the first-entry choice", () => {
    render(<LanguageChoice />);

    fireEvent.click(screen.getByRole("radio", { name: /English Continue in English/ }));

    expect(useStore.getState().languagePreferenceSet).toBe(true);
    expect(useStore.getState().language).toBe("en");
    expect(localStorage.getItem("somniq-ui-language")).toBe("en");
  });

  it("persists Chinese from the first-entry choice", () => {
    render(<LanguageChoice />);

    fireEvent.click(screen.getByRole("radio", { name: /简体中文 使用中文继续/ }));

    expect(useStore.getState().languagePreferenceSet).toBe(true);
    expect(useStore.getState().language).toBe("cn");
    expect(localStorage.getItem("somniq-ui-language")).toBe("cn");
  });

  it("persists the selected light or dark appearance from the first-entry choice", () => {
    render(<LanguageChoice />);

    fireEvent.click(screen.getByRole("radio", { name: /Bright workspace/ }));

    expect(useStore.getState().theme).toBe("light");
    expect(useStore.getState().themePreferenceSet).toBe(true);
    expect(localStorage.getItem("somniq-theme")).toBe("light");
  });

  it("uses an existing language preference on later login visits", () => {
    localStorage.setItem("somniq-ui-language", "cn");
    useStore.setState({ language: "cn", languagePreferenceSet: true });

    render(<Login />);

    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
  });
});
