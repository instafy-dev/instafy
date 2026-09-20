/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProjectBinding } from "@instafy/sdk/provider-project-binding";

const upsertProjectProviderBindingMock = vi.hoisted(() => vi.fn());
const showStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../services/runtimeController/providerBindings", () => ({
  upsertProjectProviderBinding: upsertProjectProviderBindingMock,
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({
    queue: null,
    showStatus: showStatusMock,
    hideStatus: vi.fn(),
  }),
}));

import { ProviderBindingApprovalModal } from "../ProviderBindingApprovalModal";

function createExistingBinding(
  overrides: Partial<ProviderProjectBinding> = {},
): ProviderProjectBinding {
  return {
    providerId: "demo",
    projectId: "project-1",
    rootUri: "file:///home/example/git/demo",
    grantedCapabilities: ["project_content_read"],
    grantedPrefix: ".instafy/providers/demo/",
    purpose: "Store learned robot state.",
    status: "bound_read_only",
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProviderBindingApprovalModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    upsertProjectProviderBindingMock.mockReset();
    showStatusMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  it("upgrades an existing binding to write access while preserving the bound root", async () => {
    const existingBinding = createExistingBinding();
    upsertProjectProviderBindingMock.mockResolvedValue(
      createExistingBinding({
        grantedCapabilities: ["project_content_read", "project_content_write"],
        status: "bound_read_write",
      }),
    );

    const onClose = vi.fn();
    const onSaved = vi.fn();

    await act(async () => {
      root.render(
        <ProviderBindingApprovalModal
          isOpen
          projectId="project-1"
          defaults={{
            providerId: "demo",
            purpose: "Store learned robot state.",
            preferredPrefix: ".instafy/providers/demo/",
            capabilities: ["project_content_read"],
            existingBinding,
            providerIdLocked: true,
          }}
          onClose={onClose}
          onSaved={onSaved}
        />,
      );
      await Promise.resolve();
    });

    const providerIdInput = document.querySelector(
      '[data-testid="provider-binding-provider-id"]',
    ) as HTMLInputElement | null;
    const rootUriInput = document.querySelector(
      '[data-testid="provider-binding-root-uri"]',
    ) as HTMLInputElement | null;
    const writeCheckbox = document.querySelector(
      '[data-testid="provider-binding-write"]',
    ) as HTMLInputElement | null;
    const saveButton = document.querySelector(
      '[data-testid="provider-binding-save"]',
    ) as HTMLButtonElement | null;

    for (const [id, label] of [
      ["provider-binding-provider-id", "Provider"],
      ["provider-binding-prefix", "Storage folder"],
      ["provider-binding-purpose", "Purpose"],
      ["provider-binding-root-uri", "Workspace root"],
    ]) {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
      expect(input?.labels?.[0]?.textContent).toBe(label);
    }
    expect(providerIdInput?.disabled).toBe(true);
    expect(rootUriInput?.value).toBe("file:///home/example/git/demo");
    expect(writeCheckbox?.checked).toBe(false);

    await act(async () => {
      if (writeCheckbox) {
        writeCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(writeCheckbox?.checked).toBe(true);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(upsertProjectProviderBindingMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "demo",
      purpose: "Store learned robot state.",
      grantedCapabilities: ["project_content_read", "project_content_write"],
      grantedPrefix: ".instafy/providers/demo/",
      rootUri: "file:///home/example/git/demo",
    });
    expect(showStatusMock).toHaveBeenCalledWith(
      "Updated provider access for demo.",
      "success",
      2500,
    );
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "demo",
        status: "bound_read_write",
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves an explicit desktop workspace path as a file URI", async () => {
    upsertProjectProviderBindingMock.mockResolvedValue(
      createExistingBinding({
        grantedCapabilities: ["project_content_read", "project_content_write"],
        status: "bound_read_write",
      }),
    );

    await act(async () => {
      root.render(
        <ProviderBindingApprovalModal
          isOpen
          projectId="project-1"
          defaults={{
            capabilities: ["project_content_read", "project_content_write"],
          }}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    const providerIdInput = document.querySelector(
      '[data-testid="provider-binding-provider-id"]',
    ) as HTMLInputElement | null;
    const purposeInput = document.querySelector(
      '[data-testid="provider-binding-purpose"]',
    ) as HTMLInputElement | null;
    const rootUriInput = document.querySelector(
      '[data-testid="provider-binding-root-uri"]',
    ) as HTMLInputElement | null;
    const saveButton = document.querySelector(
      '[data-testid="provider-binding-save"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      if (providerIdInput) {
        setInputValue(providerIdInput, "demo");
      }
      if (purposeInput) {
        setInputValue(purposeInput, "Let Demo use this repo.");
      }
      if (rootUriInput) {
        setInputValue(rootUriInput, "/home/example/git/demo");
      }
      await Promise.resolve();
    });

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(upsertProjectProviderBindingMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "demo",
      purpose: "Let Demo use this repo.",
      grantedCapabilities: ["project_content_read", "project_content_write"],
      grantedPrefix: ".instafy/providers/demo/",
      rootUri: "file:///home/example/git/demo",
    });
  });
});
