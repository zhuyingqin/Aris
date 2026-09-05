// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopCloseConfirmationMessage,
  installBrowserUnsavedChangesGuard,
  shouldPreventDesktopClose,
} from "./windowCloseGuard";

describe("window close guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not install the browser beforeunload guard in Tauri", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const cleanup = installBrowserUnsavedChangesGuard(true, () => true);

    expect(addEventListener).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
    cleanup();
  });

  it("protects an unsaved draft in a browser preview and removes the guard on cleanup", () => {
    const cleanup = installBrowserUnsavedChangesGuard(false, () => true);
    const guardedEvent = new Event("beforeunload", { cancelable: true });

    window.dispatchEvent(guardedEvent);
    expect(guardedEvent.defaultPrevented).toBe(true);

    cleanup();
    const eventAfterCleanup = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(eventAfterCleanup);
    expect(eventAfterCleanup.defaultPrevented).toBe(false);
  });

  it("allows a desktop close after the user confirms discarding changes", () => {
    const confirmDiscard = vi.fn(() => true);

    expect(shouldPreventDesktopClose({ hasUnsavedChanges: true, runningConversationCount: 0 }, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("blocks a desktop close when an unsaved draft is not confirmed", () => {
    const rejectDiscard = vi.fn(() => false);
    const cleanDocumentConfirm = vi.fn(() => false);

    expect(shouldPreventDesktopClose({ hasUnsavedChanges: true, runningConversationCount: 0 }, rejectDiscard)).toBe(true);
    expect(shouldPreventDesktopClose({ hasUnsavedChanges: false, runningConversationCount: 0 }, cleanDocumentConfirm)).toBe(false);
    expect(cleanDocumentConfirm).not.toHaveBeenCalled();
  });

  it("blocks a desktop close for a running conversation even with no unsaved LaTeX", () => {
    const rejectClose = vi.fn(() => false);

    expect(shouldPreventDesktopClose({ hasUnsavedChanges: false, runningConversationCount: 2 }, rejectClose)).toBe(true);
    expect(rejectClose).toHaveBeenCalledOnce();
  });

  it("makes the warning describe both active conversations and unsaved work", () => {
    expect(desktopCloseConfirmationMessage("cn", {
      hasUnsavedChanges: true,
      runningConversationCount: 2,
    })).toContain("2 个对话仍在运行");
    expect(desktopCloseConfirmationMessage("en", {
      hasUnsavedChanges: true,
      runningConversationCount: 1,
    })).toContain("1 conversation is still running");
  });
});
