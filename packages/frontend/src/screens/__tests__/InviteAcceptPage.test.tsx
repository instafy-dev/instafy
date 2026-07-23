// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteAcceptPage } from "../InviteAcceptPage";

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  showStatus: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../../providers/AuthProvider", () => ({
  useAuth: () => ({ signOut: mocks.signOut }),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    organizations: {
      acceptInvitation: mocks.acceptInvitation,
    },
  },
}));

vi.mock("../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
}));

let navigateFromTest: NavigateFunction | null = null;

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location-probe">
      {location.pathname}
      {location.search}
    </output>
  );
}

function TestRoutes() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateFromTest = navigate;
    return () => {
      navigateFromTest = null;
    };
  }, [navigate]);

  return (
    <Routes>
      <Route
        path="/invite"
        element={
          <>
            <InviteAcceptPage />
            <LocationProbe />
          </>
        }
      />
      <Route path="*" element={<LocationProbe />} />
    </Routes>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("InviteAcceptPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.acceptInvitation.mockReset();
    mocks.showStatus.mockReset();
    mocks.signOut.mockReset();
    mocks.signOut.mockResolvedValue(undefined);
    navigateFromTest = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("ignores a stale response when the invite token changes", async () => {
    const first = deferred<{
      orgName: string;
      projectId: string;
    }>();
    const second = deferred<{
      orgName: string;
      projectId: string;
    }>();
    mocks.acceptInvitation.mockImplementation(({ token }: { token: string }) =>
      token === "first" ? first.promise : second.promise,
    );

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite?token=first"]}>
          <TestRoutes />
        </MemoryRouter>,
      );
    });
    expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: "first" });

    await act(async () => {
      navigateFromTest?.("/invite?token=second");
    });
    expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: "second" });

    second.resolve({ orgName: "Second team", projectId: "project-second" });
    await flushAsyncWork();
    expect(
      document.querySelector('[data-testid="location-probe"]')?.textContent,
    ).toBe("/studio?projectId=project-second");

    first.resolve({ orgName: "First team", projectId: "project-first" });
    await flushAsyncWork();
    expect(
      document.querySelector('[data-testid="location-probe"]')?.textContent,
    ).toBe("/studio?projectId=project-second");
  });

  it("retries a failed invite without reloading the page", async () => {
    mocks.acceptInvitation
      .mockRejectedValueOnce(new Error("Invite acceptance failed."))
      .mockResolvedValueOnce({ orgName: "Retry team", projectId: "project-retry" });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite?token=retry-token"]}>
          <TestRoutes />
        </MemoryRouter>,
      );
    });
    await flushAsyncWork();

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="invite-accept-retry"]')
        ?.click();
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(mocks.acceptInvitation).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[data-testid="location-probe"]')?.textContent,
    ).toBe("/studio?projectId=project-retry");
  });

  it("preserves the full invite URL when switching accounts", async () => {
    mocks.acceptInvitation.mockRejectedValue(
      new Error("This invite belongs to another account."),
    );

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite?token=account-token&panel=chat"]}>
          <TestRoutes />
        </MemoryRouter>,
      );
    });
    await flushAsyncWork();

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="invite-accept-switch-account"]')
        ?.click();
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    const locationText =
      document.querySelector('[data-testid="location-probe"]')?.textContent ?? "";
    const query = locationText.slice(locationText.indexOf("?"));
    expect(locationText.startsWith("/login?")).toBe(true);
    expect(new URLSearchParams(query).get("redirect")).toBe(
      "/invite?token=account-token&panel=chat",
    );
  });
});
