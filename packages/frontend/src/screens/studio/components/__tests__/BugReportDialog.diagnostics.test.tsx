// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildLogEntry } from "../../../../types";

const mocks = vi.hoisted(() => ({
  collectReleaseMetadata: vi.fn(),
  createRequestId: vi.fn(),
  showStatus: vi.fn(),
  submitReport: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    bugReports: {
      submit: mocks.submitReport,
      createRequestId: mocks.createRequestId,
    },
  },
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
}));

vi.mock("../../../../updates/releaseMetadata", () => ({
  collectAppReleaseMetadata: mocks.collectReleaseMetadata,
}));

import { BugReportDialog } from "../BugReportDialog";

describe("BugReportDialog diagnostic consent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", "/studio/demo?oauth_code=secret#private-fragment");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.collectReleaseMetadata.mockReset();
    mocks.collectReleaseMetadata.mockResolvedValue({ version: "1.2.3" });
    mocks.showStatus.mockReset();
    mocks.createRequestId.mockReset();
    mocks.createRequestId
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    mocks.submitReport.mockReset();
    mocks.submitReport.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-09-05T10:00:00Z",
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderDialog(
    appLogs: BuildLogEntry[] = [
      { id: "app-1", severity: "error", message: "app detail", timestamp: 1 },
    ],
    session: {
      currentUserId: string;
      isUserSessionCurrent: (expectedUserId: string) => boolean;
      strictMode?: boolean;
    } = {
      currentUserId: "user-a",
      isUserSessionCurrent: () => true,
    },
  ) {
    await act(async () => {
      const dialog = (
        <BugReportDialog
          isOpen
          onOpenChange={vi.fn()}
          currentUserId={session.currentUserId}
          isUserSessionCurrent={session.isUserSessionCurrent}
          initialDetails="Publishing stays stuck."
          activeProjectId="project-1"
          activeConversationId="conversation-1"
          activeConversationLocalId="local-conversation-1"
          activeRuntimeId="runtime-1"
          controllerProjectMissing={false}
          appLogs={appLogs}
          buildLogs={[{ id: "runtime-1", severity: "error", message: "runtime detail", timestamp: 2 }]}
        />
      );
      root.render(session.strictMode ? <StrictMode>{dialog}</StrictMode> : dialog);
    });
  }

  async function submit() {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="bug-report-submit"]');
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function setDescription(value: string) {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="bug-report-description"]',
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      if (textarea) {
        setter?.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  it("keeps logs and diagnostic metadata off by default", async () => {
    await renderDialog();

    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="bug-report-include-diagnostics"]',
    );
    expect(checkbox?.checked).toBe(false);
    expect(document.querySelector('[data-testid="bug-report-diagnostics-preview"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "signed-in identity and email are attached for ownership and support contact",
    );

    await submit();

    expect(mocks.submitReport).toHaveBeenCalledTimes(1);
    expect(mocks.submitReport.mock.calls[0][0]).toMatchObject({
      logs: [],
      metadata: {},
      projectId: "project-1",
      conversationId: "conversation-1",
      runtimeId: "runtime-1",
    });
    expect(mocks.collectReleaseMetadata).not.toHaveBeenCalled();
  });

  it("previews and includes diagnostics only after explicit opt-in", async () => {
    await renderDialog();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="bug-report-include-diagnostics"]',
    );
    await act(async () => checkbox?.click());

    const preview = document.querySelector('[data-testid="bug-report-diagnostics-preview"]');
    expect(preview?.textContent).toContain("1 app log entries and 1 runtime log entries");
    expect(preview?.textContent).toContain("http://localhost:3000/studio/demo");
    expect(preview?.textContent).not.toContain("oauth_code");
    expect(preview?.textContent).not.toContain("private-fragment");
    expect(preview?.textContent).toContain(
      "email is used for ownership and contact, but is not duplicated inside optional diagnostics",
    );

    await submit();

    const payload = mocks.submitReport.mock.calls[0][0] as {
      logs: unknown[];
      metadata: Record<string, unknown>;
    };
    expect(payload.logs).toHaveLength(2);
    expect(payload.metadata.location).toBe("http://localhost:3000/studio/demo");
    expect(payload.metadata).not.toHaveProperty("userEmail");
    expect(mocks.collectReleaseMetadata).toHaveBeenCalledTimes(1);
  });

  it("reuses one creation request id for an uncertain retry and changes it with the payload", async () => {
    mocks.submitReport
      .mockRejectedValueOnce(new Error("Connection closed after upload."))
      .mockRejectedValueOnce(new Error("Still uncertain."))
      .mockResolvedValueOnce({
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-09-05T10:05:00Z",
      });
    await renderDialog();

    await submit();
    await submit();

    expect(mocks.submitReport).toHaveBeenCalledTimes(2);
    expect(mocks.submitReport.mock.calls[0]?.[0].clientRequestId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(mocks.submitReport.mock.calls[1]?.[0].clientRequestId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(mocks.createRequestId).toHaveBeenCalledTimes(1);

    await setDescription("Publishing now fails with a different error.");
    await submit();

    expect(mocks.submitReport.mock.calls[2]?.[0]).toMatchObject({
      details: "Publishing now fails with a different error.",
      clientRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(mocks.createRequestId).toHaveBeenCalledTimes(2);
  });

  it("pins opted-in diagnostics and the request id across an uncertain retry", async () => {
    mocks.submitReport
      .mockRejectedValueOnce(new Error("Connection closed after upload."))
      .mockResolvedValueOnce({
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-09-05T10:05:00Z",
      });
    await renderDialog();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="bug-report-include-diagnostics"]',
    );
    await act(async () => checkbox?.click());

    await submit();
    await renderDialog([
      { id: "app-1", severity: "error", message: "app detail", timestamp: 1 },
      { id: "app-2", severity: "warn", message: "new background log", timestamp: 3 },
    ]);
    await submit();

    expect(mocks.submitReport).toHaveBeenCalledTimes(2);
    expect(mocks.submitReport.mock.calls[0]?.[0].clientRequestId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(mocks.submitReport.mock.calls[1]?.[0].clientRequestId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(mocks.submitReport.mock.calls[1]?.[0].logs).toEqual(
      mocks.submitReport.mock.calls[0]?.[0].logs,
    );
    expect(mocks.submitReport.mock.calls[1]?.[0].logs).not.toContainEqual(
      expect.objectContaining({ id: "app-2" }),
    );
    expect(mocks.createRequestId).toHaveBeenCalledTimes(1);
  });

  it("does not submit an old account draft after the signed-in identity changes", async () => {
    let activeUserId = "user-a";
    let resolveReleaseMetadata: ((value: { version: string }) => void) | undefined;
    mocks.collectReleaseMetadata.mockReturnValue(
      new Promise<{ version: string }>((resolve) => {
        resolveReleaseMetadata = resolve;
      }),
    );
    await renderDialog(undefined, {
      currentUserId: activeUserId,
      isUserSessionCurrent: (expectedUserId) => expectedUserId === activeUserId,
    });
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="bug-report-include-diagnostics"]',
    );
    await act(async () => checkbox?.click());

    const button = document.querySelector<HTMLButtonElement>('[data-testid="bug-report-submit"]');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(mocks.collectReleaseMetadata).toHaveBeenCalledTimes(1);

    activeUserId = "user-b";
    await act(async () => {
      resolveReleaseMetadata?.({ version: "1.2.3" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.submitReport).not.toHaveBeenCalled();
    expect(mocks.showStatus).not.toHaveBeenCalledWith(
      expect.stringContaining("Issue report sent"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("submits and completes normally inside the app's StrictMode boundary", async () => {
    await renderDialog(undefined, {
      currentUserId: "user-a",
      isUserSessionCurrent: (expectedUserId) => expectedUserId === "user-a",
      strictMode: true,
    });
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="bug-report-include-diagnostics"]',
    );
    await act(async () => checkbox?.click());

    await submit();

    expect(mocks.submitReport).toHaveBeenCalledTimes(1);
    expect(mocks.submitReport.mock.calls[0]?.[0]).toMatchObject({ expectedUserId: "user-a" });
    expect(mocks.showStatus).toHaveBeenCalledWith(
      expect.stringContaining("Issue report sent"),
      "success",
      4000,
    );
  });
});
