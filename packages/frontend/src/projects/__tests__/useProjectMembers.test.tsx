// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../projectAccessEvents";
import { MEMBERS_CHANGED_EVENT, useProjectMembers } from "../useProjectMembers";

const mocks = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  listMembers: vi.fn(),
}));

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }) }));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    projects: {
      listMembers: mocks.listMembers,
      removeMember: vi.fn(),
      updateMemberRole: vi.fn(),
    },
  },
}));

function Probe() {
  const state = useProjectMembers("project-1");
  return (
    <div data-error={state.error ?? ""} data-testid="probe">
      {state.members.map((member) => member.email).join(",")}
    </div>
  );
}

describe("useProjectMembers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function Providers({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.listMembers.mockReset();
    mocks.userId = "user-1";
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("withholds a previously loaded protected directory after refresh failure", async () => {
    mocks.listMembers.mockResolvedValueOnce([
      {
        createdAt: "2026-07-16T12:00:00.000Z",
        email: "private@example.com",
        role: "builder",
        userId: "user-2",
      },
    ]);

    await act(async () => {
      root.render(
        <Providers>
          <Probe />
        </Providers>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("private@example.com");
      });
    });
    expect(mocks.listMembers).toHaveBeenCalledWith("project-1", {
      throwOnError: true,
    });

    mocks.listMembers.mockRejectedValueOnce(new Error("authorization expired"));
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ["project-members", "user-1", "project-1"],
        exact: true,
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector<HTMLElement>('[data-testid="probe"]')?.dataset.error,
        ).toBe("authorization expired");
      });
    });

    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]');
    expect(probe?.dataset.error).toBe("authorization expired");
    expect(container.textContent).not.toContain("private@example.com");
  });

  it("withholds the previous account's directory when accounts switch in the same project", async () => {
    mocks.listMembers.mockResolvedValueOnce([{ createdAt: "2026-09-06", email: "private@example.com", role: "viewer", userId: "guest-1" }]);
    await act(async () => root.render(<Providers><Probe /></Providers>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("private@example.com");

    mocks.userId = "user-2";
    let resolveNext!: (members: unknown[]) => void;
    mocks.listMembers.mockReturnValueOnce(new Promise((resolve) => { resolveNext = resolve; }));
    await act(async () => root.render(<Providers><Probe /></Providers>));
    expect(container.textContent).not.toContain("private@example.com");
    expect(mocks.listMembers).toHaveBeenCalledTimes(2);

    await act(async () => resolveNext([]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).not.toContain("private@example.com");
  });

  it("does not fetch a protected directory without a signed-in user", async () => {
    mocks.userId = null;
    await act(async () => root.render(<Providers><Probe /></Providers>));
    expect(mocks.listMembers).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("does not refetch on a timer", async () => {
    vi.useFakeTimers();
    mocks.listMembers.mockResolvedValue([
      { createdAt: "2026-09-06", email: "member@example.com", role: "viewer", userId: "user-2" },
    ]);
    await act(async () => root.render(<Providers><Probe /></Providers>));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(container.textContent).toContain("member@example.com");
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);
  });

  it.each([
    [PROJECT_ACCESS_REFRESH_EVENT, { projectId: "project-1" }],
    [PROJECT_ACCESS_REFRESH_EVENT, { projectId: null }],
    [PROJECT_ACCESS_REFRESH_EVENT, undefined],
    [MEMBERS_CHANGED_EVENT, { projectId: "project-1", orgId: "org-1" }],
    ["instafy:controller-stream-reconnected", undefined],
  ])("refetches the directory on %s with detail %o", async (eventName, detail) => {
    mocks.listMembers.mockResolvedValueOnce([
      { createdAt: "2026-09-06", email: "member@example.com", role: "viewer", userId: "user-2" },
    ]);
    await act(async () => root.render(<Providers><Probe /></Providers>));
    await act(async () => {
      await vi.waitFor(() => { expect(container.textContent).toContain("member@example.com"); });
    });

    mocks.listMembers.mockResolvedValueOnce([
      { createdAt: "2026-09-06", email: "member@example.com", role: "viewer", userId: "user-2" },
      { createdAt: "2026-09-07", email: "joined@example.com", role: "builder", userId: "user-3" },
    ]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    });
    await act(async () => {
      await vi.waitFor(() => { expect(container.textContent).toContain("joined@example.com"); });
    });
    expect(mocks.listMembers).toHaveBeenCalledTimes(2);
  });

  it("fetches again when a members change arrives during a fetch that began before it", async () => {
    const member = { createdAt: "2026-09-06", email: "member@example.com", role: "viewer", userId: "user-2" };
    const joined = { createdAt: "2026-09-07", email: "joined@example.com", role: "builder", userId: "user-3" };
    mocks.listMembers.mockResolvedValueOnce([member]);
    await act(async () => root.render(<Providers><Probe /></Providers>));
    await act(async () => {
      await vi.waitFor(() => { expect(container.textContent).toContain("member@example.com"); });
    });

    // A refetch (focus, say) reads the roster before the change commits...
    let resolveStale!: (members: unknown[]) => void;
    mocks.listMembers.mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }));
    mocks.listMembers.mockResolvedValueOnce([member, joined]);
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: ["project-members", "user-1", "project-1"], exact: true });
    });
    expect(mocks.listMembers).toHaveBeenCalledTimes(2);

    // ...the signal joins that fetch instead of cancelling it...
    await act(async () => {
      window.dispatchEvent(new CustomEvent(MEMBERS_CHANGED_EVENT, { detail: { projectId: "project-1" } }));
      window.dispatchEvent(new CustomEvent(MEMBERS_CHANGED_EVENT, { detail: { projectId: "project-1" } }));
    });
    expect(mocks.listMembers).toHaveBeenCalledTimes(2);

    // ...and one more fetch after it settles picks the change up.
    await act(async () => resolveStale([member]));
    await act(async () => {
      await vi.waitFor(() => { expect(container.textContent).toContain("joined@example.com"); });
    });
    expect(mocks.listMembers).toHaveBeenCalledTimes(3);
  });

  it.each([PROJECT_ACCESS_REFRESH_EVENT, MEMBERS_CHANGED_EVENT])(
    "ignores %s for another project",
    async (eventName) => {
      mocks.listMembers.mockResolvedValue([
        { createdAt: "2026-09-06", email: "member@example.com", role: "viewer", userId: "user-2" },
      ]);
      await act(async () => root.render(<Providers><Probe /></Providers>));
      await act(async () => {
        await vi.waitFor(() => { expect(container.textContent).toContain("member@example.com"); });
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent(eventName, { detail: { projectId: "project-2" } }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(mocks.listMembers).toHaveBeenCalledTimes(1);
    },
  );
});
