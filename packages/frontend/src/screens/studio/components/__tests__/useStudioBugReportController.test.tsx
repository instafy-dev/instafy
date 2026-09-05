// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BugReportScreenshotDraft } from "../bugReportDrafts";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("../../../../debug/appLogs", () => ({ logAppInfo: vi.fn(), logAppWarn: vi.fn() }));
vi.mock("../../../../debug/useAppLogs", () => ({ useAppLogs: () => ({ logs: [] }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../bugReportCapture", () => ({ captureCurrentScreenBugReportDraft: mocks.capture }));
vi.mock("../BugReportInboxDialog", () => ({ BugReportInboxDialog: () => null }));
vi.mock("../BugReportDialog", () => ({
  BugReportDialog: ({ isOpen, onOpenChange, initialMessage, initialScreenshots }: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    initialMessage?: string;
    initialScreenshots: BugReportScreenshotDraft[];
  }) => isOpen ? (
    <div role="dialog">
      <span>{initialMessage ?? "Report issue"}</span>
      <span data-testid="screenshot-count">{initialScreenshots.length}</span>
      <button onClick={() => onOpenChange(false)}>Close report</button>
    </div>
  ) : null,
}));

import { dispatchOpenBugReport } from "../bugReportEvents";
import { NATIVE_SHAKE_REPORT_EVENT } from "../useShakeToReport";
import { useStudioBugReportController } from "../useStudioBugReportController";

function Harness() {
  return useStudioBugReportController({
    activeProjectId: null,
    activeConversationId: null,
    activeConversationLocalId: null,
    activeRuntimeId: null,
    userEmail: null,
    controllerProjectMissing: false,
    buildLogs: [],
  }).dialogs;
}

const screenshot: BugReportScreenshotDraft = {
  id: "screenshot-1",
  fileName: "screen.png",
  mediaType: "image/png",
  dataBase64: "AA==",
  byteLength: 1,
  previewUrl: "data:image/png;base64,AA==",
};

function deferredCapture() {
  let resolve!: (value: BugReportScreenshotDraft) => void;
  const promise = new Promise<BugReportScreenshotDraft>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("shake issue report opening", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mocks.capture.mockReset();
    window.localStorage.clear();
    window.localStorage.setItem("instafy.shakeReportEnabled", "1");
    mocks.capture.mockResolvedValue(screenshot);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => root.render(<Harness />));
  }

  async function shake() {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(NATIVE_SHAKE_REPORT_EVENT, { detail: { source: "accelerometer" } }));
    });
  }

  async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTimeAsync(ms));
  }

  async function closeReport() {
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  }

  it("receives a native shake and attaches a completed screenshot", async () => {
    await mount();
    await shake();
    await shake();
    await advance(100);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="screenshot-count"]')?.textContent).toBe("1");
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("opens without a screenshot when capture fails", async () => {
    mocks.capture.mockRejectedValue(new Error("Screenshot unavailable"));
    await mount();
    await shake();
    await advance(100);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="screenshot-count"]')?.textContent).toBe("0");
    expect(mocks.showStatus).toHaveBeenCalledWith("Screenshot unavailable", "info", 4000);
  });

  it("opens after the capture deadline, ignores a late screenshot, and allows another shake", async () => {
    const first = deferredCapture();
    mocks.capture.mockReturnValueOnce(first.promise);
    await mount();
    await shake();
    await advance(3100);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="screenshot-count"]')?.textContent).toBe("0");
    expect(mocks.showStatus).toHaveBeenCalledWith(expect.stringContaining("timed out"), "info", 4000);

    await closeReport();
    await act(async () => dispatchOpenBugReport({ message: "Manual report" }));
    await act(async () => first.resolve(screenshot));
    expect(container.textContent).toContain("Manual report");
    expect(container.querySelector('[data-testid="screenshot-count"]')?.textContent).toBe("0");

    await closeReport();
    await shake();
    await advance(100);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="screenshot-count"]')?.textContent).toBe("1");
  });

  it("also bounds a paused animation-frame callback", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    await mount();
    await shake();
    await advance(3100);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not overwrite a manual report opened while capture is pending", async () => {
    const pending = deferredCapture();
    mocks.capture.mockReturnValueOnce(pending.promise);
    await mount();
    await shake();
    await advance(100);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    await act(async () => dispatchOpenBugReport({ message: "Manual report" }));
    await act(async () => pending.resolve(screenshot));
    expect(container.textContent).toContain("Manual report");
    expect(container.querySelector('[data-testid="screenshot-count"]')?.textContent).toBe("0");
  });

  it("preserves the opt-in setting", async () => {
    window.localStorage.setItem("instafy.shakeReportEnabled", "0");
    await mount();
    await shake();
    await advance(3100);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.getItem("instafy.shakeReportEnabled")).toBe("0");
  });
});
