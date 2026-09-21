// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMBERS_CHANGED_EVENT,
  PROJECT_ACCESS_REFRESH_EVENT,
} from "../../../../projects/projectAccessEvents";
import {
  canShareProjectForOrgRole,
  useChatOrgMembers,
} from "../useChatOrgMembers";

const mocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listOrganizations: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    organizations: {
      list: mocks.listOrganizations,
      listMembers: mocks.listMembers,
    },
  },
}));

const builderOrg = [{ id: "org-1", name: "Team", role: "builder", slug: "team" }];
const builderMember = {
  createdAt: "2026-01-01T00:00:00.000Z",
  email: "first@example.com",
  role: "builder",
  userId: "user-1",
};

function Probe({
  activeOrgId = "org-1",
  testId = "probe",
}: {
  activeOrgId?: string;
  testId?: string;
}) {
  const state = useChatOrgMembers({
    activeOrgId,
    currentUserId: "user-1",
    enabled: true,
  });
  return (
    <div
      data-can-share={String(state.canShareProject)}
      data-error={state.error ?? ""}
      data-loading={String(state.loading)}
      data-role={state.currentUserRole ?? ""}
      data-testid={testId}
    >
      {state.members.map((member) => member.email).join(",")}
    </div>
  );
}

describe("useChatOrgMembers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  function render(node: ReactNode) {
    return act(async () => {
      root.render(<Providers>{node}</Providers>);
      await Promise.resolve();
    });
  }

  function probe(testId = "probe") {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function dispatch(eventName: string) {
    return act(async () => {
      window.dispatchEvent(new Event(eventName));
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    mocks.listMembers.mockReset();
    mocks.listOrganizations.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("only grants space sharing to builder-level organization roles", () => {
    expect(canShareProjectForOrgRole("owner")).toBe(true);
    expect(canShareProjectForOrgRole("admin")).toBe(true);
    expect(canShareProjectForOrgRole("builder")).toBe(true);
    expect(canShareProjectForOrgRole("viewer")).toBe(false);
    expect(canShareProjectForOrgRole(null)).toBe(false);
  });

  it("does not request the protected member directory for a project guest", async () => {
    mocks.listOrganizations.mockResolvedValue([
      { id: "another-org", name: "Other team", role: "viewer", slug: "other" },
    ]);

    await render(<Probe />);
    await vi.waitFor(() => {
      expect(mocks.listOrganizations).toHaveBeenCalledTimes(1);
      expect(probe()?.dataset.loading).toBe("false");
    });

    expect(mocks.listMembers).not.toHaveBeenCalled();
    expect(mocks.listOrganizations).toHaveBeenCalledWith({ throwOnError: true });
    expect(probe()?.dataset.role).toBe("");
    expect(probe()?.dataset.canShare).toBe("false");

    await dispatch("focus");
    await vi.waitFor(() => {
      expect(mocks.listOrganizations).toHaveBeenCalledTimes(2);
    });
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });

  it("keeps a failed authorized directory unresolved instead of treating it as empty", async () => {
    mocks.listOrganizations.mockRejectedValue(new Error("controller unavailable"));

    await render(<Probe />);

    await vi.waitFor(() => {
      expect(probe()?.dataset.loading).toBe("false");
      expect(probe()?.dataset.error).toBe("controller unavailable");
    });
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });

  it("refreshes the member list and current role when the window regains focus", async () => {
    mocks.listOrganizations.mockResolvedValueOnce(builderOrg);
    mocks.listMembers.mockResolvedValueOnce([builderMember]);

    await render(<Probe />);
    await vi.waitFor(() => {
      expect(probe()?.textContent).toContain("first@example.com");
    });
    expect(probe()?.dataset.role).toBe("builder");
    expect(probe()?.dataset.canShare).toBe("true");
    expect(mocks.listMembers).toHaveBeenCalledWith("org-1", {
      throwOnError: true,
    });

    mocks.listOrganizations.mockResolvedValueOnce([
      { id: "org-1", name: "Team", role: "viewer", slug: "team" },
    ]);
    mocks.listMembers.mockResolvedValueOnce([
      { ...builderMember, role: "viewer" },
      {
        createdAt: "2026-01-02T00:00:00.000Z",
        email: "second@example.com",
        role: "builder",
        userId: "user-2",
      },
    ]);
    // Fresh data (inside staleTime) still refetches on focus.
    await dispatch("focus");

    await vi.waitFor(() => {
      expect(probe()?.dataset.role).toBe("viewer");
      expect(probe()?.textContent).toContain("second@example.com");
    });
    expect(probe()?.dataset.canShare).toBe("false");
  });

  it("clears a previously authorized directory when a later refresh fails", async () => {
    mocks.listOrganizations.mockResolvedValueOnce(builderOrg);
    mocks.listMembers.mockResolvedValueOnce([
      { ...builderMember, email: "private@example.com" },
    ]);

    await render(<Probe />);
    await vi.waitFor(() => {
      expect(probe()?.dataset.canShare).toBe("true");
      expect(probe()?.textContent).toContain("private@example.com");
    });

    mocks.listOrganizations.mockRejectedValueOnce(new Error("authorization expired"));
    await dispatch("focus");

    await vi.waitFor(() => {
      expect(probe()?.dataset.error).toBe("authorization expired");
      expect(probe()?.dataset.canShare).toBe("false");
      expect(probe()?.dataset.role).toBe("");
      expect(probe()?.textContent).not.toContain("private@example.com");
    });
  });

  it("fails closed during an organization prop switch while the next directory loads", async () => {
    mocks.listOrganizations.mockResolvedValueOnce([
      { id: "org-1", name: "First team", role: "builder", slug: "first" },
      { id: "org-2", name: "Second team", role: "builder", slug: "second" },
    ]);
    mocks.listMembers.mockResolvedValueOnce([
      { ...builderMember, email: "first-private@example.com" },
    ]);

    await render(<Probe activeOrgId="org-1" />);
    await vi.waitFor(() => {
      expect(probe()?.textContent).toContain("first-private@example.com");
      expect(probe()?.dataset.canShare).toBe("true");
    });

    let resolveSecondDirectory!: (value: unknown[]) => void;
    mocks.listMembers.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveSecondDirectory = resolve;
        }),
    );

    await act(async () => {
      root.render(
        <Providers>
          <Probe activeOrgId="org-2" />
        </Providers>,
      );
    });

    // The cached organization list (one request per user) is reused; the
    // org-2 directory is a new key and nothing from org-1 may show meanwhile.
    expect(mocks.listOrganizations).toHaveBeenCalledTimes(1);
    expect(probe()?.textContent).not.toContain("first-private@example.com");
    expect(probe()?.dataset.role).toBe("");
    expect(probe()?.dataset.canShare).toBe("false");
    expect(probe()?.dataset.loading).toBe("true");

    await act(async () => {
      resolveSecondDirectory([]);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(probe()?.dataset.loading).toBe("false");
    });
    expect(probe()?.dataset.role).toBe("builder");
  });

  it("treats a switch to an organization missing from the cached list as a guest", async () => {
    mocks.listOrganizations.mockResolvedValueOnce(builderOrg);
    mocks.listMembers.mockResolvedValueOnce([
      { ...builderMember, email: "first-private@example.com" },
    ]);

    await render(<Probe activeOrgId="org-1" />);
    await vi.waitFor(() => {
      expect(probe()?.textContent).toContain("first-private@example.com");
    });

    await act(async () => {
      root.render(
        <Providers>
          <Probe activeOrgId="org-2" />
        </Providers>,
      );
    });

    expect(probe()?.textContent).not.toContain("first-private@example.com");
    expect(probe()?.dataset.role).toBe("");
    expect(probe()?.dataset.canShare).toBe("false");
    expect(probe()?.dataset.loading).toBe("false");
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);
  });

  it("does not refetch on a timer", async () => {
    vi.useFakeTimers();
    mocks.listOrganizations.mockResolvedValue(builderOrg);
    mocks.listMembers.mockResolvedValue([builderMember]);

    await render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(probe()?.textContent).toContain("first@example.com");
    expect(mocks.listOrganizations).toHaveBeenCalledTimes(1);
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(mocks.listOrganizations).toHaveBeenCalledTimes(1);
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);
  });

  it.each([
    PROJECT_ACCESS_REFRESH_EVENT,
    "instafy:controller-stream-reconnected",
    "instafy:orgs-updated",
    MEMBERS_CHANGED_EVENT,
  ])("refetches the roster on %s", async (eventName) => {
    mocks.listOrganizations.mockResolvedValue(builderOrg);
    mocks.listMembers.mockResolvedValueOnce([builderMember]);

    await render(<Probe />);
    await vi.waitFor(() => {
      expect(probe()?.textContent).toContain("first@example.com");
    });

    mocks.listMembers.mockResolvedValueOnce([
      builderMember,
      {
        createdAt: "2026-01-02T00:00:00.000Z",
        email: "joined@example.com",
        role: "viewer",
        userId: "user-2",
      },
    ]);
    await dispatch(eventName);

    await vi.waitFor(() => {
      expect(probe()?.textContent).toContain("joined@example.com");
    });
    expect(mocks.listOrganizations).toHaveBeenCalledTimes(2);
    expect(mocks.listMembers).toHaveBeenCalledTimes(2);
  });

  it("fetches the organization list once for two mounted subscribers", async () => {
    mocks.listOrganizations.mockResolvedValue(builderOrg);
    mocks.listMembers.mockResolvedValue([builderMember]);

    await render(
      <>
        <Probe testId="first" />
        <Probe testId="second" />
      </>,
    );
    await vi.waitFor(() => {
      expect(probe("first")?.textContent).toContain("first@example.com");
      expect(probe("second")?.textContent).toContain("first@example.com");
    });

    expect(mocks.listOrganizations).toHaveBeenCalledTimes(1);
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);
  });
});
