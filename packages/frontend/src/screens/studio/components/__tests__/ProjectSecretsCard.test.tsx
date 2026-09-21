// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDraftsProvider, useStudioDraftStore } from "../../../../workspace/StudioDrafts";
import { controllerClient } from "../../../../sdk/instafy";
import { ProjectSecretsCard } from "../ProjectSecretsCard";
import {
  clearPendingProjectSecretPrefill,
  setPendingProjectSecretPrefill,
} from "../secretManagerDeepLink";

// The receiving half of the deep link. The card in the chat names a value and
// sends the person here; this panel has to open on that value with the words
// that came with it, and then forget it, so that walking away and coming back
// does not reopen a form nobody asked for. The link itself is held in memory
// rather than in storage, so these tests drive it through its real setter
// instead of seeding a key by hand.

const mocks = vi.hoisted(() => ({
  showStatus: vi.fn(),
  openPanelTab: vi.fn(),
  requestUrlPush: vi.fn(),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openPanelTab: mocks.openPanelTab,
    requestUrlPush: mocks.requestUrlPush,
  }),
}));

vi.mock("../../../../providers/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1", handle: "owner" } }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { secrets: [], agents: [] },
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    secrets: { listForProject: vi.fn(), createForProject: vi.fn(), updateForProject: vi.fn() },
    agents: { list: vi.fn() },
  },
}));

let draftStore: ReturnType<typeof useStudioDraftStore>;
function DraftProbe() { draftStore = useStudioDraftStore(); return null; }
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(projectId: string | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<StudioDraftsProvider><DraftProbe /><ProjectSecretsCard projectId={projectId} /></StudioDraftsProvider>);
  });
}

function unmount() {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
}

function field(testId: string): HTMLInputElement | HTMLTextAreaElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearPendingProjectSecretPrefill();
  vi.clearAllMocks();
});

afterEach(() => {
  unmount();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("project secrets panel", () => {
  it("returns to the requesting chat only after a successful save releases the editor guard", async () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "EXAMPLE_KEY", agentHandles: ["octo"], returnPanelTab: "chat" });
    vi.mocked(controllerClient.secrets.createForProject).mockResolvedValue({ success: true });
    render("project-1");
    expect(draftStore!.getSnapshot().protections).toHaveLength(1);
    const input = field("project-secret-value-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "inert-test-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    mocks.openPanelTab.mockImplementation(() => expect(draftStore!.getSnapshot().protections).toHaveLength(0));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="project-secret-save"]')!.click());
    expect(mocks.openPanelTab).toHaveBeenCalledExactlyOnceWith("chat", { activate: true });
  });

  it("opens on the value the chat card named, with the words that came with it", () => {
    setPendingProjectSecretPrefill({
      projectId: "project-1",
      name: "NOTION_API_KEY",
      description: "Lets Instafy read the pages you share with it.",
      agentHandles: ["octo"],
    });

    render("project-1");

    expect(document.querySelector('[data-testid="project-secret-modal"]')).not.toBeNull();
    expect(field("project-secret-name-input")?.value).toBe("NOTION_API_KEY");
    expect(field("project-secret-description-input")?.value).toBe(
      "Lets Instafy read the pages you share with it.",
    );
  });

  it("forgets the link once it has been followed", () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "NOTION_API_KEY" });
    render("project-1");
    expect(field("project-secret-name-input")?.value).toBe("NOTION_API_KEY");
    unmount();

    // Coming back to the panel on its own is not following the link a second
    // time, and must not reopen the form.
    render("project-1");
    expect(document.querySelector('[data-testid="project-secret-modal"]')).toBeNull();
  });

  it("ignores a link left behind for a different project", () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "NOTION_API_KEY" });
    render("project-2");
    expect(document.querySelector('[data-testid="project-secret-modal"]')).toBeNull();
  });
});
