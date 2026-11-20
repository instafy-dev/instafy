// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestContext: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: { core: { resolveRequestContext: mocks.resolveRequestContext } },
}));

import {
  canStartSpaceOnThisComputer,
  describeDesktopSpaceStartOutcome,
  startSpaceOnThisComputer,
} from "../desktopSpaceStart";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";

describe("starting a space on this computer", () => {
  let startDesktopRuntime: ReturnType<typeof vi.fn>;
  let desktopRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.resolveRequestContext.mockResolvedValue({
      baseUrl: "https://controller.example.test",
      accessToken: "inert-session",
      credentialSource: "ambient",
    });
    startDesktopRuntime = vi.fn(async () => ({ pid: 42 }));
    desktopRuntimeStatus = vi.fn(async () => ({ running: true, projectId: PROJECT_ID, runtimeId: "runtime-1" }));
    Object.assign(window, { instafyDesktop: { startDesktopRuntime, desktopRuntimeStatus } });
  });

  afterEach(() => {
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
  });

  it("asks Desktop to start the space with the session Studio talks to the controller with", async () => {
    expect(canStartSpaceOnThisComputer()).toBe(true);
    const outcome = await startSpaceOnThisComputer(PROJECT_ID);
    expect(startDesktopRuntime).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT_ID,
      controllerUrl: "https://controller.example.test",
      controllerAccessToken: "inert-session",
      controllerCredentialMode: "ambient",
      displayName: "Instafy Desktop",
    });
    expect(outcome).toEqual({
      kind: "started",
      status: { running: true, projectId: PROJECT_ID, runtimeId: "runtime-1" },
    });
    expect(describeDesktopSpaceStartOutcome(outcome)).toEqual({
      message: "Started this space on this computer.",
      intent: "success",
      durationMs: 3200,
    });
  });

  it("shares a start already under way for the same space", async () => {
    let finish: (value: unknown) => void = () => {};
    startDesktopRuntime.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const first = startSpaceOnThisComputer(PROJECT_ID);
    const second = startSpaceOnThisComputer(PROJECT_ID);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(startDesktopRuntime).toHaveBeenCalled());
    finish({ pid: 42 });
    await first;
    expect(startDesktopRuntime).toHaveBeenCalledTimes(1);
    // Once it settled, the next one starts anew.
    startDesktopRuntime.mockResolvedValue({ pid: 43 });
    await startSpaceOnThisComputer(PROJECT_ID);
    expect(startDesktopRuntime).toHaveBeenCalledTimes(2);
  });

  it("says why it didn't start: outside Desktop, without a session, or Desktop's own reason", async () => {
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    expect(canStartSpaceOnThisComputer()).toBe(false);
    const unavailable = await startSpaceOnThisComputer(PROJECT_ID);
    expect(describeDesktopSpaceStartOutcome(unavailable).message).toBe(
      "Use Instafy Desktop to start this space on your computer.",
    );

    Object.assign(window, { instafyDesktop: { startDesktopRuntime, desktopRuntimeStatus } });
    mocks.resolveRequestContext.mockResolvedValue({ baseUrl: "https://controller.example.test", accessToken: null });
    const signedOut = await startSpaceOnThisComputer(PROJECT_ID);
    expect(describeDesktopSpaceStartOutcome(signedOut)).toMatchObject({
      message: "Sign in again to start this space on this computer.",
      intent: "error",
    });

    mocks.resolveRequestContext.mockResolvedValue({ baseUrl: "https://controller.example.test", accessToken: "inert" });
    startDesktopRuntime.mockRejectedValue(new Error("Instafy is still working on this computer."));
    const refused = await startSpaceOnThisComputer(PROJECT_ID);
    expect(describeDesktopSpaceStartOutcome(refused).message).toBe(
      "Couldn't start this space on this computer: Instafy is still working on this computer.",
    );
  });
});
