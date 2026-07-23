// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function Probe({ activeOrgId = "org-1" }: { activeOrgId?: string }) {
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
      data-testid="probe"
    >
      {state.members.map((member) => member.email).join(",")}
    </div>
  );
}

describe("useChatOrgMembers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.listMembers.mockReset();
    mocks.listOrganizations.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
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

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.listOrganizations).toHaveBeenCalledTimes(1);
    });

    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]');
    expect(mocks.listMembers).not.toHaveBeenCalled();
    expect(mocks.listOrganizations).toHaveBeenCalledWith({ throwOnError: true });
    expect(probe?.dataset.loading).toBe("false");
    expect(probe?.dataset.role).toBe("");
    expect(probe?.dataset.canShare).toBe("false");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.listOrganizations).toHaveBeenCalledTimes(2);
    });
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });

  it("keeps a failed authorized directory unresolved instead of treating it as empty", async () => {
    mocks.listOrganizations.mockRejectedValue(new Error("controller unavailable"));

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });

    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]');
    await vi.waitFor(() => {
      expect(probe?.dataset.loading).toBe("false");
      expect(probe?.dataset.error).toBe("controller unavailable");
    });
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });

  it("refreshes the member list and current role when the window regains focus", async () => {
    mocks.listOrganizations.mockResolvedValueOnce([
      { id: "org-1", name: "Team", role: "builder", slug: "team" },
    ]);
    mocks.listMembers.mockResolvedValueOnce([
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "first@example.com",
        role: "builder",
        userId: "user-1",
      },
    ]);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]');
    expect(probe?.dataset.role).toBe("builder");
    expect(probe?.dataset.canShare).toBe("true");
    expect(probe?.textContent).toContain("first@example.com");
    expect(mocks.listMembers).toHaveBeenCalledWith("org-1", {
      throwOnError: true,
    });

    mocks.listOrganizations.mockResolvedValueOnce([
      { id: "org-1", name: "Team", role: "viewer", slug: "team" },
    ]);
    mocks.listMembers.mockResolvedValueOnce([
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "first@example.com",
        role: "viewer",
        userId: "user-1",
      },
      {
        createdAt: "2026-01-02T00:00:00.000Z",
        email: "second@example.com",
        role: "builder",
        userId: "user-2",
      },
    ]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(probe?.dataset.role).toBe("viewer");
    expect(probe?.dataset.canShare).toBe("false");
    expect(probe?.textContent).toContain("second@example.com");
  });

  it("clears a previously authorized directory when a later refresh fails", async () => {
    mocks.listOrganizations.mockResolvedValueOnce([
      { id: "org-1", name: "Team", role: "builder", slug: "team" },
    ]);
    mocks.listMembers.mockResolvedValueOnce([
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "private@example.com",
        role: "builder",
        userId: "user-1",
      },
    ]);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]');
    await vi.waitFor(() => {
      expect(probe?.dataset.canShare).toBe("true");
      expect(probe?.textContent).toContain("private@example.com");
    });

    mocks.listOrganizations.mockRejectedValueOnce(new Error("authorization expired"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(probe?.dataset.error).toBe("authorization expired");
      expect(probe?.dataset.canShare).toBe("false");
      expect(probe?.dataset.role).toBe("");
      expect(probe?.textContent).not.toContain("private@example.com");
    });
  });

  it("fails closed during an organization prop switch before the next effect runs", async () => {
    mocks.listOrganizations.mockResolvedValueOnce([
      { id: "org-1", name: "First team", role: "builder", slug: "first" },
    ]);
    mocks.listMembers.mockResolvedValueOnce([
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "first-private@example.com",
        role: "builder",
        userId: "user-1",
      },
    ]);

    await act(async () => {
      root.render(<Probe activeOrgId="org-1" />);
      await Promise.resolve();
    });
    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]');
    await vi.waitFor(() => {
      expect(probe?.textContent).toContain("first-private@example.com");
      expect(probe?.dataset.canShare).toBe("true");
    });

    let resolveSecondOrganization!: (value: unknown[]) => void;
    mocks.listOrganizations.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => {
        resolveSecondOrganization = resolve;
      }),
    );

    await act(async () => {
      root.render(<Probe activeOrgId="org-2" />);
    });

    expect(probe?.textContent).not.toContain("first-private@example.com");
    expect(probe?.dataset.role).toBe("");
    expect(probe?.dataset.canShare).toBe("false");
    expect(probe?.dataset.loading).toBe("true");

    await act(async () => {
      resolveSecondOrganization([]);
      await Promise.resolve();
    });
  });
});
