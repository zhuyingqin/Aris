// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newapiAuthStatus, newapiSendVerification } from "../api/tauri";
import { DEFAULT_AUTH_SERVER, useStore } from "../store";
import Login from "./Login";
vi.mock("../api/tauri", async (original) => ({
  ...await original<typeof import("../api/tauri")>(),
  newapiAuthStatus: vi.fn(), newapiSendVerification: vi.fn(),
}));
const originalState = useStore.getState();
const status = {
  registerEnabled: true, passwordRegisterEnabled: true, passwordLoginEnabled: true,
  emailVerification: true, turnstileCheck: false, turnstileSiteKey: "",
  userAgreementEnabled: false, privacyPolicyEnabled: false,
};
const register = vi.fn();
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
async function openRegistration() {
  render(<Login />); await settle();
  fireEvent.click(screen.getByRole("tab", { name: "Sign up" })); await settle();
}
function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  vi.mocked(newapiAuthStatus).mockResolvedValue(status);
  vi.mocked(newapiSendVerification).mockResolvedValue(undefined);
  register.mockResolvedValue(undefined);
  useStore.setState({ authServer: DEFAULT_AUTH_SERVER, language: "en", register });
});
afterEach(() => { cleanup(); vi.useRealTimers(); useStore.setState(originalState); });
it("refreshes verification requirements when entering registration", async () => {
  vi.mocked(newapiAuthStatus).mockResolvedValueOnce({ ...status, emailVerification: false });
  await openRegistration();
  expect(newapiAuthStatus).toHaveBeenCalledTimes(2);
  expect((screen.getByPlaceholderText("name@example.com") as HTMLInputElement).required).toBe(true);
  expect((screen.getByPlaceholderText("Email verification code") as HTMLInputElement).required).toBe(true);
});
it("sends a code, applies cooldown and includes it in registration", async () => {
  await openRegistration();
  fill("Username", "researcher"); fill("8-20 characters", "password123");
  fill("Re-enter your password", "password123"); fill("name@example.com", "reader@example.com");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
  expect(newapiSendVerification).toHaveBeenCalledWith({ baseUrl: DEFAULT_AUTH_SERVER, email: "reader@example.com" });
  expect((screen.getByRole("button", { name: "30s" }) as HTMLButtonElement).disabled).toBe(true);
  fill("Email verification code", "123456");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create account" })); });
  expect(register).toHaveBeenCalledWith(DEFAULT_AUTH_SERVER, "researcher", "password123", {
    email: "reader@example.com", verificationCode: "123456", affCode: undefined,
  });
  expect(screen.getByRole("status").textContent).toContain("Registration successful");
});
it("clears a code when the email changes", async () => {
  await openRegistration(); fill("Email verification code", "123456"); fill("name@example.com", "other@example.com");
  expect((screen.getByPlaceholderText("Email verification code") as HTMLInputElement).value).toBe("");
});
it("allows retry after a send failure", async () => {
  vi.mocked(newapiSendVerification).mockRejectedValueOnce(new Error("Email delivery failed"));
  await openRegistration(); fill("name@example.com", "reader@example.com");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
  expect(screen.getByRole("alert").textContent).toContain("Email delivery failed");
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
});
