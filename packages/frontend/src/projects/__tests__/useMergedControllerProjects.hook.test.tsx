// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listProjectsMock = vi.hoisted(() => vi.fn());
const listOrganizationsMock = vi.hoisted(() => vi.fn());
const authStateMock = vi.hoisted(() => ({
  loading: false,
  session: { access_token: "token-123" },
  user: { id: "user-1" },
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    projects: {
      list: listProjectsMock,
      getSummaryResult: vi.fn(),
    },
    organizations: {
      list: listOrganizationsMock,
    },
  },
}));

vi.mock("../../providers/AuthProvider", () => ({
  useAuth: () => authStateMock,
}));

import { useMergedControllerProjects } from "../useMergedControllerProjects";

type HookResult = ReturnType<typeof useMergedControllerProjects>;

function Harness({ resultRef }: { resultRef: MutableRefObject<HookResult | null> }) {
  resultRef.current = useMergedControllerProjects({
    localProjects: [],
  });
  return null;
}

describe("useMergedControllerProjects accessible discovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listProjectsMock.mockReset();
    listOrganizationsMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("loads project-only memberships from personal scope without enumerating organizations", async () => {
    listProjectsMock.mockResolvedValue([
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        projectName: "Directly shared space",
        orgId: "22222222-2222-4222-8222-222222222222",
        orgName: "External team",
      },
    ]);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });

    expect(listProjectsMock).toHaveBeenCalledWith();
    expect(listOrganizationsMock).not.toHaveBeenCalled();
    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(resultRef.current?.mergedProjects).toEqual([
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Directly shared space",
        orgId: "22222222-2222-4222-8222-222222222222",
        isRemoteOnly: true,
      }),
    ]);
  });

  it("falls back to legacy organization discovery while GET /projects is rolling out", async () => {
    listProjectsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          projectId: "33333333-3333-4333-8333-333333333333",
          projectName: "Existing team space",
          orgId: "44444444-4444-4444-8444-444444444444",
          orgName: "Existing team",
        },
      ]);
    listOrganizationsMock.mockResolvedValue([
      { id: "44444444-4444-4444-8444-444444444444" },
    ]);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });

    expect(listProjectsMock).toHaveBeenNthCalledWith(1);
    expect(listProjectsMock).toHaveBeenNthCalledWith(2, {
      orgId: "44444444-4444-4444-8444-444444444444",
    });
    expect(resultRef.current?.mergedProjects).toEqual([
      expect.objectContaining({
        id: "33333333-3333-4333-8333-333333333333",
        name: "Existing team space",
        isRemoteOnly: true,
      }),
    ]);
  });
});
