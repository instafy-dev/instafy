// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeviceAuthFlow } from "../useDeviceAuthFlow";

const sdkMock = vi.hoisted(() => ({
  startDeviceAuth: vi.fn(),
  getDeviceAuthStatus: vi.fn(),
  cancelDeviceAuth: vi.fn(),
}));

const completionMock = vi.fn();

vi.mock("../../../../../sdk/instafy", () => ({
  controllerClient: {
    credentials: {
      startDeviceAuth: sdkMock.startDeviceAuth,
      getDeviceAuthStatus: sdkMock.getDeviceAuthStatus,
      cancelDeviceAuth: sdkMock.cancelDeviceAuth,
    },
  },
}));

let captured: ReturnType<typeof useDeviceAuthFlow> | null = null;

function Harness({
  onCompleted = completionMock,
}: {
  onCompleted?: typeof completionMock;
} = {}) {
  captured = useDeviceAuthFlow({ onCompleted });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushEffects(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("useDeviceAuthFlow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sdkMock.startDeviceAuth.mockReset();
    sdkMock.getDeviceAuthStatus.mockReset();
    sdkMock.cancelDeviceAuth.mockReset();
    completionMock.mockReset();
    completionMock.mockResolvedValue({ success: true });
    sdkMock.getDeviceAuthStatus.mockResolvedValue({ success: true, status: "pending" });
    sdkMock.cancelDeviceAuth.mockResolvedValue({ success: true });
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not restore an old device-auth session after the flow is reset", async () => {
    type StartResult = {
      success: true;
      sessionId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: string;
      pollIntervalSeconds: number;
    };
    const pendingStart = deferred<StartResult>();
    sdkMock.startDeviceAuth.mockReturnValue(pendingStart.promise);

    let beginPromise: Promise<void> | undefined;
    act(() => {
      beginPromise = captured?.begin({ provider: "github" });
    });
    expect(captured?.busy).toBe(true);

    act(() => captured?.reset());
    expect(captured?.busy).toBe(false);
    pendingStart.resolve({
      success: true,
      sessionId: "old-session",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    await act(async () => beginPromise);

    expect(captured?.session).toBeNull();
    expect(captured?.provider).toBeNull();
    expect(captured?.error).toBeNull();
    expect(captured?.busy).toBe(false);
  });

  it("turns an expired session into an actionable failure without polling", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "expired-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      pollIntervalSeconds: 5,
    });

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });

    expect(captured?.session?.status).toBe("failed");
    expect(captured?.error).toContain("timed out");
    expect(sdkMock.getDeviceAuthStatus).not.toHaveBeenCalled();
  });

  it("fails immediately when the controller no longer knows the session", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "missing-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    sdkMock.getDeviceAuthStatus.mockResolvedValue({
      success: false,
      error: "Unable to check device login: device auth session not found",
    });

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });

    expect(captured?.session?.status).toBe("failed");
    expect(captured?.error).toContain("session ended");
  });

  it("ignores a stale polling failure after a newer session is hydrated", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "old-poll-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    const oldPoll = deferred<{ success: false; error: string }>();
    sdkMock.getDeviceAuthStatus
      .mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValue({ success: true, status: "pending" });

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });
    await flushEffects(2);

    act(() => {
      captured?.hydrate({
        provider: "github",
        session: {
          sessionId: "new-poll-session",
          verificationUrl: "https://github.com/login/device",
          userCode: "WXYZ-1234",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          pollIntervalSeconds: 5,
          status: "pending",
          error: null,
        },
      });
    });
    oldPoll.resolve({ success: false, error: "device auth session not found" });
    await flushEffects();

    expect(captured?.session?.sessionId).toBe("new-poll-session");
    expect(captured?.session?.status).toBe("pending");
    expect(captured?.provider).toBe("github");
    expect(captured?.error).toBeNull();
  });

  it("recovers from a failed start on the next begin", async () => {
    sdkMock.startDeviceAuth.mockResolvedValueOnce({
      success: false,
      error: "Too many pending device logins. Try again shortly.",
    });

    await act(async () => {
      await captured?.begin({ provider: "github" });
    });

    expect(captured?.session).toBeNull();
    expect(captured?.error).toContain("Too many pending device logins");
    expect(captured?.busy).toBe(false);

    sdkMock.startDeviceAuth.mockResolvedValueOnce({
      success: true,
      sessionId: "second-session",
      verificationUrl: "https://github.com/login/device",
      userCode: "WXYZ-1234",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });

    await act(async () => {
      await captured?.begin({ provider: "github" });
    });

    // The stale start error must not survive into the new pending session,
    // and a failed start must never leave the hook stuck busy.
    expect(captured?.error).toBeNull();
    expect(captured?.session?.sessionId).toBe("second-session");
    expect(captured?.session?.status).toBe("pending");
    expect(captured?.busy).toBe(false);
  });

  it("cancels the controller session before clearing local state", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "cancel-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });
    await act(async () => {
      await captured?.cancel();
    });

    expect(sdkMock.cancelDeviceAuth).toHaveBeenCalledWith("cancel-session");
    expect(captured?.session).toBeNull();
    expect(captured?.provider).toBeNull();
  });

  it("does not let a stale cancellation clear a newer hydrated session", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "cancel-old-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    const cancellation = deferred<{ success: true }>();
    sdkMock.cancelDeviceAuth.mockReturnValue(cancellation.promise);

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });

    let cancelPromise: Promise<void> | undefined;
    act(() => {
      cancelPromise = captured?.cancel();
    });
    expect(captured?.busy).toBe(true);

    act(() => {
      captured?.hydrate({
        provider: "github",
        session: {
          sessionId: "new-session",
          verificationUrl: "https://github.com/login/device",
          userCode: "WXYZ-1234",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          pollIntervalSeconds: 5,
          status: "pending",
          error: null,
        },
      });
    });
    cancellation.resolve({ success: true });
    await act(async () => cancelPromise);

    expect(captured?.session?.sessionId).toBe("new-session");
    expect(captured?.provider).toBe("github");
    expect(captured?.busy).toBe(false);
  });

  it("does not invalidate an in-flight begin when cancel is requested while busy", async () => {
    const start = deferred<{
      success: true;
      sessionId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: string;
      pollIntervalSeconds: number;
    }>();
    sdkMock.startDeviceAuth.mockReturnValue(start.promise);

    let beginPromise: Promise<void> | undefined;
    act(() => {
      beginPromise = captured?.begin({ provider: "codex" });
    });
    expect(captured?.busy).toBe(true);

    await act(async () => {
      await captured?.cancel();
    });
    expect(captured?.busy).toBe(true);

    start.resolve({
      success: true,
      sessionId: "started-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    await act(async () => beginPromise);

    expect(captured?.busy).toBe(false);
    expect(captured?.session?.sessionId).toBe("started-session");
  });

  it("exposes finalization while the completed login is being checked", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "completing-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    sdkMock.getDeviceAuthStatus.mockResolvedValue({
      success: true,
      status: "completed",
      credentialId: "credential-1",
    });
    const completion = deferred<{ success: true }>();
    completionMock.mockReturnValue(completion.promise);

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });

    await flushEffects();
    expect(captured?.completing).toBe(true);
    expect(captured?.session?.status).toBe("pending");

    const replacementCompletion = vi.fn().mockResolvedValue({ success: true });
    await act(async () => {
      root.render(<Harness onCompleted={replacementCompletion} />);
    });
    await flushEffects();
    expect(completionMock).toHaveBeenCalledTimes(1);
    expect(replacementCompletion).not.toHaveBeenCalled();

    completion.resolve({ success: true });
    await flushEffects();
    expect(captured?.completing).toBe(false);
    expect(captured?.session?.status).toBe("completed");
  });

  it("does not restore a completed session after reset during finalization", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "reset-completing-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    sdkMock.getDeviceAuthStatus.mockResolvedValue({
      success: true,
      status: "completed",
      credentialId: "credential-reset",
    });
    const completion = deferred<{ success: true; warning?: string }>();
    completionMock.mockReturnValue(completion.promise);

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });
    await flushEffects();
    expect(captured?.completing).toBe(true);
    expect(completionMock).toHaveBeenCalledTimes(1);

    act(() => captured?.reset());
    expect(captured?.session).toBeNull();
    expect(captured?.provider).toBeNull();
    expect(captured?.completing).toBe(false);

    completion.resolve({ success: true, warning: "stale warning" });
    await flushEffects();
    expect(captured?.session).toBeNull();
    expect(captured?.provider).toBeNull();
    expect(captured?.completing).toBe(false);
    expect(captured?.completionWarning).toBeNull();
    expect(captured?.error).toBeNull();
    expect(completionMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a persisted login completed when finalization returns a warning", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "warning-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    sdkMock.getDeviceAuthStatus.mockResolvedValue({
      success: true,
      status: "completed",
      credentialId: "credential-2",
    });
    completionMock.mockResolvedValue({
      success: true,
      warning: "Connection saved; verification is temporarily unavailable.",
    });

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });

    await flushEffects();
    expect(captured?.session?.status).toBe("completed");
    expect(captured?.completionWarning).toContain("verification is temporarily unavailable");
    expect(captured?.error).toBeNull();
  });

  it("still fails when the controller reports that device login failed", async () => {
    sdkMock.startDeviceAuth.mockResolvedValue({
      success: true,
      sessionId: "failed-session",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
    });
    sdkMock.getDeviceAuthStatus.mockResolvedValue({
      success: true,
      status: "failed",
      error: "Authorization was denied.",
    });

    await act(async () => {
      await captured?.begin({ provider: "codex" });
    });

    await flushEffects();
    expect(captured?.session?.status).toBe("failed");
    expect(captured?.error).toBe("Authorization was denied.");
    expect(completionMock).not.toHaveBeenCalled();
  });
});
