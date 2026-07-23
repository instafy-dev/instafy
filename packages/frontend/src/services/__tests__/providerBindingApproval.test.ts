import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProjectBinding } from "@instafy/sdk/provider-project-binding";
import {
  PROVIDER_BINDING_REQUEST_EVENT,
  dispatchProviderBindingResult,
  type ProviderBindingRequestDetail,
} from "../../screens/studio/components/providerBindingEvents";

const readProjectProviderBindingStoreMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/providerBindings", () => ({
  readProjectProviderBindingStore: readProjectProviderBindingStoreMock,
}));

import {
  ensureProjectProviderCapability,
  providerBindingHasCapability,
} from "../runtimeController/providerBindingApproval";

function createBinding(
  overrides: Partial<ProviderProjectBinding> = {},
): ProviderProjectBinding {
  return {
    providerId: "demo",
    projectId: "project-1",
    rootUri: "file:///home/example/git/demo",
    grantedCapabilities: ["project_content_write"],
    grantedPrefix: ".instafy/providers/demo/",
    purpose: "Store learned robot state.",
    status: "bound_read_write",
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("provider binding approval helpers", () => {
  beforeEach(() => {
    readProjectProviderBindingStoreMock.mockReset();
    const fakeWindow = new EventTarget() as EventTarget & {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };
    fakeWindow.setTimeout = setTimeout;
    fakeWindow.clearTimeout = clearTimeout;
    vi.stubGlobal("window", fakeWindow);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("detects granted capabilities on an existing binding", () => {
    expect(
      providerBindingHasCapability(
        createBinding({
          grantedCapabilities: ["project_content_read", "project_content_write"],
        }),
        "project_content_write",
      ),
    ).toBe(true);

    expect(
      providerBindingHasCapability(
        createBinding({
          grantedCapabilities: ["project_content_read"],
          status: "bound_read_only",
        }),
        "project_content_write",
      ),
    ).toBe(false);
  });

  it("returns an existing binding without opening the approval flow", async () => {
    readProjectProviderBindingStoreMock.mockResolvedValue({
      version: 1,
      bindings: {
        demo: createBinding(),
      },
    });

    await expect(
      ensureProjectProviderCapability({
        projectId: "project-1",
        providerId: "demo",
        requiredCapability: "project_content_write",
        projectAccess: {
          required: true,
          purpose: "Store learned robot state.",
          requestedCapabilities: ["project_content_read", "project_content_write"],
          preferredPrefix: ".instafy/providers/demo/",
        },
      }),
    ).resolves.toMatchObject({
      providerId: "demo",
      status: "bound_read_write",
    });
  });

  it("requests approval when the required capability is missing", async () => {
    readProjectProviderBindingStoreMock.mockResolvedValue({
      version: 1,
      bindings: {},
    });

    window.addEventListener(
      PROVIDER_BINDING_REQUEST_EVENT,
      ((event: Event) => {
        const detail = (event as CustomEvent<ProviderBindingRequestDetail>).detail;
        expect(detail.providerId).toBe("demo");
        expect(detail.projectId).toBe("project-1");
        expect(detail.projectAccess.requestedCapabilities).toEqual([
          "project_content_read",
          "project_content_write",
        ]);

        queueMicrotask(() => {
          dispatchProviderBindingResult({
            providerId: "demo",
            projectId: "project-1",
            approved: true,
            binding: createBinding(),
          });
        });
      }) as EventListener,
      { once: true },
    );

    await expect(
      ensureProjectProviderCapability({
        projectId: "project-1",
        providerId: "demo",
        requiredCapability: "project_content_write",
        projectAccess: {
          required: true,
          purpose: "Store learned robot state.",
          requestedCapabilities: ["project_content_read"],
          preferredPrefix: ".instafy/providers/demo/",
        },
      }),
    ).resolves.toMatchObject({
      providerId: "demo",
      status: "bound_read_write",
    });
  });
});
