// @vitest-environment jsdom

import { Capacitor } from "@capacitor/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordGenuineAssistantResponseAndMaybeOfferNativeNotifications } from "../nativeNotificationsNudge";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

describe("native notifications nudge", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  });

  it("offers only after three genuine assistant responses", () => {
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(true);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
  });

  it("does not count responses when a notification preference already exists", () => {
    window.localStorage.setItem("instafy.notifications.enabled", "0");
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);

    window.localStorage.removeItem("instafy.notifications.enabled");
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(true);
  });

  it("never offers outside the native app", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(recordGenuineAssistantResponseAndMaybeOfferNativeNotifications()).toBe(false);
  });
});
