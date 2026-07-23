/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProjectAccessDescriptor } from "@instafy/sdk/provider-project-binding";

const readMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());
const fetchLocalWorkspacePresenceMock = vi.hoisted(() => vi.fn());
const useProjectMock = vi.hoisted(() => vi.fn());
const showStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/workspaceFiles", () => ({
  readWorkspaceFileFromController: readMock,
  writeWorkspaceFileToController: writeMock,
}));

vi.mock("../runtimeController/origins", () => ({
  fetchLocalWorkspacePresence: fetchLocalWorkspacePresenceMock,
}));

vi.mock("../../projects/useProject", () => ({
  useProject: useProjectMock,
}));

vi.mock("../../status/useStatus", () => ({
  useStatus: () => ({
    queue: null,
    showStatus: showStatusMock,
    hideStatus: vi.fn(),
  }),
}));

import { ProviderBindingApprovalHost } from "../../screens/studio/components/ProviderBindingApprovalHost";
import {
  ensureProjectProviderCapability,
} from "../runtimeController/providerBindingApproval";
import {
  PROVIDER_BINDINGS_PATH,
  revokeProjectProviderBinding,
} from "../runtimeController/providerBindings";

const PROJECT_ACCESS: ProviderProjectAccessDescriptor = {
  required: true,
  purpose: "Store learned robot state, replay reports, and session-derived summaries for Robot Lab.",
  requestedCapabilities: ["project_content_read", "project_content_write"],
  preferredPrefix: ".instafy/providers/demo/",
};

function getActionButton(testId: string) {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
}

function createStoredBindingStore(
  capabilities: ("project_content_read" | "project_content_write")[],
) {
  const status = capabilities.includes("project_content_write")
    ? "bound_read_write"
    : capabilities.includes("project_content_read")
      ? "bound_read_only"
      : "unbound";

  return JSON.stringify(
    {
      version: 1,
      bindings: {
        demo: {
          providerId: "demo",
          projectId: "project-1",
          rootUri: "file:///home/example/git/demo",
          grantedCapabilities: capabilities,
          grantedPrefix: ".instafy/providers/demo/",
          purpose: "Store learned robot state, replay reports, and session-derived summaries for Robot Lab.",
          status,
          createdAt: "2026-04-22T12:00:00.000Z",
          updatedAt: "2026-04-22T12:00:00.000Z",
        },
      },
    },
    null,
    2,
  );
}

describe("provider binding approval flow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bindingFileText: string | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    bindingFileText = null;

    readMock.mockReset();
    writeMock.mockReset();
    fetchLocalWorkspacePresenceMock.mockReset();
    useProjectMock.mockReset();
    showStatusMock.mockReset();

    useProjectMock.mockReturnValue({
      activeProjectId: "project-1",
      activeProjectName: "Robot Project",
      projectInitialized: true,
      projectAccessPending: false,
      projectAccessBlocked: false,
    });

    readMock.mockImplementation(async (params: { path?: string }) => {
      if (params.path !== PROVIDER_BINDINGS_PATH || bindingFileText == null) {
        return null;
      }
      return {
        isText: true,
        contentText: bindingFileText,
      };
    });

    writeMock.mockImplementation(async (params: { content?: string }) => {
      bindingFileText = typeof params.content === "string" ? params.content : null;
      return { ok: true };
    });

    fetchLocalWorkspacePresenceMock.mockResolvedValue({
      path: "/home/example/git/demo",
      status: "online",
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  it("approves, reuses, revokes, and re-gates Demo project write access", async () => {
    const performedMutations: string[] = [];

    await act(async () => {
      root.render(<ProviderBindingApprovalHost />);
      await Promise.resolve();
    });

    const performRobotLabMutation = async () => {
      const binding = await ensureProjectProviderCapability({
        projectId: "project-1",
        providerId: "demo",
        projectAccess: PROJECT_ACCESS,
        requiredCapability: "project_content_write",
        timeoutMs: 2_000,
      });
      performedMutations.push(binding.status);
      return binding;
    };

    let firstMutationPromise!: Promise<unknown>;
    await act(async () => {
      firstMutationPromise = performRobotLabMutation();
      await Promise.resolve();
    });

    expect(getActionButton("provider-binding-save")).toBeTruthy();
    expect(performedMutations).toEqual([]);

    await act(async () => {
      getActionButton("provider-binding-save")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await expect(firstMutationPromise).resolves.toMatchObject({
      providerId: "demo",
      projectId: "project-1",
      status: "bound_read_write",
      grantedCapabilities: ["project_content_read", "project_content_write"],
      rootUri: "file:///home/example/git/demo",
    });

    expect(performedMutations).toEqual(["bound_read_write"]);
    expect(showStatusMock).toHaveBeenCalledWith(
      "Granted provider access to demo.",
      "success",
      2500,
    );
    expect(bindingFileText).toBeTruthy();
    expect(JSON.parse(bindingFileText ?? "{}")).toMatchObject({
      version: 1,
      bindings: {
        demo: {
          providerId: "demo",
          projectId: "project-1",
          status: "bound_read_write",
          grantedCapabilities: ["project_content_read", "project_content_write"],
        },
      },
    });

    await expect(performRobotLabMutation()).resolves.toMatchObject({
      providerId: "demo",
      status: "bound_read_write",
    });
    expect(performedMutations).toEqual(["bound_read_write", "bound_read_write"]);
    expect(getActionButton("provider-binding-save")).toBeFalsy();
    expect(writeMock).toHaveBeenCalledTimes(1);

    await expect(
      revokeProjectProviderBinding({
        projectId: "project-1",
        providerId: "demo",
      }),
    ).resolves.toBe(true);
    expect(JSON.parse(bindingFileText ?? "{}")).toEqual({
      version: 1,
      bindings: {},
    });

    let thirdMutationPromise!: Promise<
      | { ok: true; binding: unknown }
      | { ok: false; message: string }
    >;
    await act(async () => {
      thirdMutationPromise = performRobotLabMutation()
        .then((binding) => ({ ok: true as const, binding }))
        .catch((error) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        }));
      await Promise.resolve();
    });

    expect(getActionButton("provider-binding-cancel")).toBeTruthy();

    await act(async () => {
      getActionButton("provider-binding-cancel")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    await expect(thirdMutationPromise).resolves.toEqual({
      ok: false,
      message: "Provider access was not approved for demo.",
    });
    expect(performedMutations).toEqual(["bound_read_write", "bound_read_write"]);
  });

  it("upgrades an existing read-only binding to write access", async () => {
    bindingFileText = createStoredBindingStore(["project_content_read"]);

    await act(async () => {
      root.render(<ProviderBindingApprovalHost />);
      await Promise.resolve();
    });

    let mutationPromise!: Promise<unknown>;
    await act(async () => {
      mutationPromise = ensureProjectProviderCapability({
        projectId: "project-1",
        providerId: "demo",
        projectAccess: PROJECT_ACCESS,
        requiredCapability: "project_content_write",
        timeoutMs: 2_000,
      });
      await Promise.resolve();
    });

    expect(getActionButton("provider-binding-save")).toBeTruthy();

    await act(async () => {
      getActionButton("provider-binding-save")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await expect(mutationPromise).resolves.toMatchObject({
      providerId: "demo",
      status: "bound_read_write",
      grantedCapabilities: ["project_content_read", "project_content_write"],
    });

    expect(showStatusMock).toHaveBeenCalledWith(
      "Updated provider access for demo.",
      "success",
      2500,
    );
    expect(JSON.parse(bindingFileText ?? "{}")).toMatchObject({
      bindings: {
        demo: {
          status: "bound_read_write",
          grantedCapabilities: ["project_content_read", "project_content_write"],
        },
      },
    });
  });

  it("rejects approval requests for a different active project", async () => {
    useProjectMock.mockReturnValue({
      activeProjectId: "project-2",
      activeProjectName: "Other Project",
      projectInitialized: true,
      projectAccessPending: false,
      projectAccessBlocked: false,
    });

    await act(async () => {
      root.render(<ProviderBindingApprovalHost />);
      await Promise.resolve();
    });

    await expect(
      ensureProjectProviderCapability({
        projectId: "project-1",
        providerId: "demo",
        projectAccess: PROJECT_ACCESS,
        requiredCapability: "project_content_write",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("Switch to the requested project before approving provider access.");

    expect(showStatusMock).toHaveBeenCalledWith(
      "Switch to the requested project before approving provider access.",
      "warning",
      3500,
    );
    expect(getActionButton("provider-binding-save")).toBeFalsy();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("still allows approval when the stored bindings file cannot be read", async () => {
    readMock.mockImplementation(async (params: { path?: string }) => {
      if (params.path !== PROVIDER_BINDINGS_PATH) {
        return null;
      }
      return {
        isText: true,
        contentText: "{not valid json",
      };
    });

    await act(async () => {
      root.render(<ProviderBindingApprovalHost />);
      await Promise.resolve();
    });

    let mutationPromise!: Promise<unknown>;
    await act(async () => {
      mutationPromise = ensureProjectProviderCapability({
        projectId: "project-1",
        providerId: "demo",
        projectAccess: PROJECT_ACCESS,
        requiredCapability: "project_content_write",
        timeoutMs: 2_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getActionButton("provider-binding-save")).toBeTruthy();

    await act(async () => {
      getActionButton("provider-binding-save")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await expect(mutationPromise).resolves.toMatchObject({
      providerId: "demo",
      status: "bound_read_write",
      grantedCapabilities: ["project_content_read", "project_content_write"],
    });

    expect(showStatusMock).toHaveBeenCalledWith(
      "Granted provider access to demo.",
      "success",
      2500,
    );
  });
});
