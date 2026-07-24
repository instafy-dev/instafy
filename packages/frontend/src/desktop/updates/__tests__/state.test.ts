// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_UPDATER_STATUS_CHANGED_EVENT,
  publishDesktopUpdaterSnapshot,
  readStoredDesktopUpdaterSnapshot,
  type StoredDesktopUpdaterSnapshot,
} from "../state";

const snapshot: StoredDesktopUpdaterSnapshot = {
  channel: "stable",
  currentVersion: "1.2.3",
  availableVersion: "1.2.4",
  phase: "update_available",
  feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
  lastCheckedAt: "2026-07-21T12:00:00.000Z",
  lastDownloadedAt: null,
  lastError: null,
};

describe("desktop updater snapshot state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists a polled status and publishes it to mounted update surfaces", () => {
    const listener = vi.fn();
    window.addEventListener(DESKTOP_UPDATER_STATUS_CHANGED_EVENT, listener);

    publishDesktopUpdaterSnapshot(snapshot);

    expect(readStoredDesktopUpdaterSnapshot()).toEqual(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(snapshot);

    window.removeEventListener(DESKTOP_UPDATER_STATUS_CHANGED_EVENT, listener);
  });
});
