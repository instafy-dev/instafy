// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDraftsProvider, useStudioDraftStore } from "../../../../workspace/StudioDrafts";
import { controllerClient, type ControllerAgentProfile, type ControllerProjectSecret } from "../../../../sdk/instafy";
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
  query: {
    data: { secrets: [] as ControllerProjectSecret[], agents: [] as ControllerAgentProfile[] },
    error: null as Error | null,
    isFetching: false,
    refetch: vi.fn(),
  },
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
  useQuery: () => mocks.query,
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
  mocks.query.data = { secrets: [], agents: [] };
  mocks.query.error = null;
  mocks.query.isFetching = false;
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("project secrets panel", () => {
  const secret: ControllerProjectSecret = {
    id: "secret-1", name: "EXAMPLE_KEY", description: "An inert example credential.",
    agentIds: [], agentHandles: ["octo"], lastUsedAt: null, revokedAt: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };

  it("keeps the edit action attached to its secret and opens an empty replacement value", async () => {
    mocks.query.data.secrets = [secret];
    render("project-1");
    const row = document.querySelector('[data-testid="project-secret-row-secret-1"]')!;
    expect(row.textContent).toContain("EXAMPLE_KEY");
    expect(row.textContent).toContain("Agents: @octo");
    expect(row.querySelector('[data-testid="project-secret-edit-secret-1"]')?.getAttribute("aria-label")).toBe("Edit EXAMPLE_KEY");
    expect(row.querySelector('[data-testid="project-secret-revoke-secret-1"]')?.getAttribute("aria-label")).toBe("Revoke EXAMPLE_KEY");
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="project-secret-edit-secret-1"]')!.click());
    expect(field("project-secret-name-input")?.value).toBe("EXAMPLE_KEY");
    expect(field("project-secret-name-input")?.disabled).toBe(true);
    expect(field("project-secret-value-input")?.value).toBe("");
    expect(field("project-secret-value-input")?.placeholder).toBe("Leave blank to keep current value");
  });

  it("labels the permission group and prevents permission edits while saving", async () => {
    mocks.query.data.agents = [{
      id: "agent-octo", handle: "octo", displayName: "Octo", description: null, bio: null,
      avatarSeed: "octo", provider: "openai", model: null, reasoningEffort: null,
      credentialId: null, runtimeId: null, createdAt: "", updatedAt: "",
    }];
    let finishSave!: (value: { success: boolean }) => void;
    vi.mocked(controllerClient.secrets.createForProject).mockReturnValueOnce(new Promise(resolve => {
      finishSave = resolve;
    }));
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "EXAMPLE_KEY", agentHandles: ["octo"] });
    render("project-1");
    const permission = document.querySelector<HTMLInputElement>('[data-testid="project-secret-agent-agent-octo"]')!;
    const group = permission.closest("fieldset")!;
    expect(group.querySelector("legend")?.textContent).toBe("Allowed agents");
    expect(permission.checked).toBe(true);
    expect(permission.disabled).toBe(false);
    const input = field("project-secret-value-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "inert-test-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="project-secret-save"]')!.click());
    expect(permission.disabled).toBe(true);
    await act(async () => permission.click());
    expect(permission.checked).toBe(true);
    expect(controllerClient.secrets.createForProject).toHaveBeenCalledWith("project-1", expect.objectContaining({ agentHandles: ["octo"] }));
    await act(async () => finishSave({ success: true }));
    expect(document.querySelector('[data-testid="project-secret-modal"]')).toBeNull();
  });

  it("announces a failed refresh with one retry and hides previously loaded secret metadata", async () => {
    mocks.query.data.secrets = [secret];
    mocks.query.error = new Error("Access is unavailable");
    render("project-1");
    expect(container!.textContent).not.toContain("EXAMPLE_KEY");
    const alert = container!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn't refresh secrets. Try again.");
    const retry = alert.querySelector<HTMLButtonElement>("button")!;
    expect(retry.textContent).toBe("Retry");
    expect(container!.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container!.querySelector<HTMLButtonElement>('[data-testid="project-secret-create"]')!.disabled).toBe(true);
    await act(async () => retry.click());
    expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });

  it("returns to the requesting chat only after a successful save releases the editor guard", async () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "EXAMPLE_KEY", agentHandles: ["octo"], returnPanelTab: "chat" });
    vi.mocked(controllerClient.secrets.createForProject).mockResolvedValue({ success: true });
    render("project-1");
    expect(draftStore!.getSnapshot().protections).toHaveLength(0);
    const input = field("project-secret-value-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "inert-test-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(draftStore!.getSnapshot().protections).toHaveLength(1);
    mocks.openPanelTab.mockImplementation(() => expect(draftStore!.getSnapshot().protections).toHaveLength(0));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="project-secret-save"]')!.click());
    expect(mocks.openPanelTab).toHaveBeenCalledExactlyOnceWith("chat", { activate: true });
  });

  it("keeps the secret draft mounted with separate header and footer when the phone keyboard reduces the viewport", async () => {
    const viewport = Object.assign(new EventTarget(), {
      offsetTop: 0, offsetLeft: 0, width: 411, height: 811, scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "EXAMPLE_KEY" });
    render("project-1");
    const input = field("project-secret-value-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unsaved-test-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const scrollBody = dialog.querySelector("[data-mobile-dialog-body]")!;
    const save = document.querySelector('[data-testid="project-secret-save"]')!;
    const close = document.querySelector('[aria-label="Close"]')!;
    expect(scrollBody.contains(input)).toBe(true);
    expect(scrollBody.contains(save)).toBe(false);
    expect(scrollBody.contains(close)).toBe(false);
    expect(dialog.parentElement?.style.height).toBe("811px");
    await act(async () => {
      viewport.height = 448;
      viewport.dispatchEvent(new Event("resize"));
      await new Promise(requestAnimationFrame);
    });
    expect(dialog.parentElement?.style.height).toBe("448px");
    expect(field("project-secret-value-input")).toBe(input);
    expect(input.value).toBe("unsaved-test-value");
    expect(document.activeElement).toBe(input);
    expect(save.isConnected).toBe(true);
    expect(close.isConnected).toBe(true);
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
