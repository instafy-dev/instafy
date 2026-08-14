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
  previewInvitation: vi.fn(),
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
      previewInvitation: mocks.previewInvitation,
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
    mocks.previewInvitation.mockReset();
    mocks.previewInvitation.mockResolvedValue(null);
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


  async function joinIfOffered() {
    const join = document.querySelector<HTMLElement>('[data-testid="invite-accept-join"]');
    if (join) {
      await act(async () => {
        join.click();
        await Promise.resolve();
      });
      await flushAsyncWork();
    await joinIfOffered();
    }
  }

  it("shows who invited you, to what, and as which role before joining", async () => {
    mocks.previewInvitation.mockResolvedValue({
      kind: "invitation", orgId: "o", orgSlug: "acme", orgName: "Acme",
      role: "builder", invitedEmailMasked: "m\u2026@example.com",
      inviterName: "Marcus", inviterEmail: null,
      projectId: "p", projectName: "Website", conversationId: null,
      conversationName: null, expiresAt: null,
    });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite?token=rich-token"]}>
          <TestRoutes />
        </MemoryRouter>,
      );
    });
    await flushAsyncWork();
    expect(document.body.textContent).toContain("Marcus invited you to join Acme");
    expect(document.body.textContent).toContain("Project: Website");
    expect(document.body.textContent).toContain("Edit access");
    expect(document.body.textContent).toContain("Invite sent to m\u2026@example.com");
    // Nothing accepted yet: consent still required.
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
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
    await joinIfOffered();
    expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: "first" });

    await act(async () => {
      navigateFromTest?.("/invite?token=second");
    });
    expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: "second" });

    second.resolve({ orgName: "Second team", projectId: "project-second" });
    await flushAsyncWork();
    await joinIfOffered();
    expect(
      document.querySelector('[data-testid="location-probe"]')?.textContent,
    ).toBe("/studio?projectId=project-second");

    first.resolve({ orgName: "First team", projectId: "project-first" });
    await flushAsyncWork();
    await joinIfOffered();
    expect(
      document.querySelector('[data-testid="location-probe"]')?.textContent,
    ).toBe("/studio?projectId=project-second");
  });

  it("surfaces the backend's precise error instead of a generic dead end", async () => {
    // The service used to swallow controller errors and return null, which
    // collapsed "invitation has expired" and "wrong email address" into one
    // unhelpful message. The rethrow makes the backend copy reach the screen:
    // the wrong-account user now learns email is the issue, right next to the
    // "Use another account" button that fixes it.
    mocks.acceptInvitation.mockRejectedValueOnce(
      new Error(
        "You must be signed in with the invited email address to accept this invitation.",
      ),
    );

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite?token=wrong-account-token"]}>
          <TestRoutes />
        </MemoryRouter>,
      );
    });
    await flushAsyncWork();
    await joinIfOffered();

    expect(document.body.textContent).toContain(
      "You must be signed in with the invited email address",
    );
    expect(document.body.textContent).not.toContain(
      "It may have expired or been canceled",
    );
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
    await joinIfOffered();

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="invite-accept-retry"]')
        ?.click();
      await Promise.resolve();
    });
    await flushAsyncWork();
    await joinIfOffered();

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
    await joinIfOffered();

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="invite-accept-switch-account"]')
        ?.click();
      await Promise.resolve();
    });
    await flushAsyncWork();
    await joinIfOffered();

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
