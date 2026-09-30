// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_AUTH_SERVER, useStore } from "../store";
import Login from "./Login";
vi.mock("../api/tauri", async (original) => ({
  ...await original<typeof import("../api/tauri")>(),
  newapiAuthStatus: vi.fn().mockResolvedValue({ registerEnabled: true, passwordRegisterEnabled: true, passwordLoginEnabled: true }),
}));
const originalState = useStore.getState();
const login = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); login.mockReset(); localStorage.clear();
  useStore.setState({ authServer: DEFAULT_AUTH_SERVER, language: "en", login, authed: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); useStore.setState(originalState); });
async function begin() {
  login.mockRejectedValueOnce("AUTH_TWO_FACTOR_REQUIRED");
  render(<Login />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "password123" } });
  await submit();
}
async function submit() { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log in" })); }); }
it("prompts for a second factor and submits an authenticator code", async () => {
  await begin();
  expect(useStore.getState().authed).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  const input = screen.getByLabelText("Two-step verification code");
  expect((input as HTMLInputElement).required).toBe(true);
  login.mockResolvedValueOnce(undefined);
  fireEvent.change(input, { target: { value: " 123456 " } });
  await submit();
  expect(login).toHaveBeenLastCalledWith(DEFAULT_AUTH_SERVER, "alice", "password123", "123456");
});
it("keeps verification available after an invalid code and accepts a backup code", async () => {
  await begin();
  login.mockRejectedValueOnce("Invalid verification code");
  fireEvent.change(screen.getByLabelText("Two-step verification code"), { target: { value: "000000" } });
  await submit();
  expect(screen.getByRole("alert").textContent).toContain("Invalid verification code");
  expect((screen.getByLabelText("Two-step verification code") as HTMLInputElement).value).toBe("");
  login.mockResolvedValueOnce(undefined);
  fireEvent.change(screen.getByLabelText("Two-step verification code"), { target: { value: "backup-code" } });
  await submit();
  expect(login).toHaveBeenLastCalledWith(DEFAULT_AUTH_SERVER, "alice", "password123", "backup-code");
});
it("clears the second factor when changing accounts or switching to registration", async () => {
  await begin();
  fireEvent.change(screen.getByLabelText("Two-step verification code"), { target: { value: "123456" } });
  fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "bob" } });
  expect(screen.queryByLabelText("Two-step verification code")).toBeNull();
  login.mockRejectedValueOnce("AUTH_TWO_FACTOR_REQUIRED"); await submit();
  expect(screen.getByLabelText("Two-step verification code")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
  expect(screen.queryByLabelText("Two-step verification code")).toBeNull();
});
