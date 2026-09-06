// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectMembers } from "../useProjectMembers";

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
});
