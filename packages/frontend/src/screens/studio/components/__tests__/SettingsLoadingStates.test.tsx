// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsPanel } from "../AutomationsPanel";
import { ProjectSecretsCard } from "../ProjectSecretsCard";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import type { ControllerAutomation, ControllerProjectSecret } from "../../../../sdk/instafy";

const mocks = vi.hoisted(() => ({
  projectId: "project-a",
  userId: "user-a",
  listAutomations: vi.fn(),
  listSecrets: vi.fn(),
  listAgents: vi.fn(),
  revokeSecret: vi.fn(),
  showStatus: vi.fn(),
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: mocks.projectId }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ openConversationTab: vi.fn(), openPanelTab: vi.fn(), requestUrlPush: vi.fn() }) }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  automations: { listForProject: mocks.listAutomations },
  secrets: { listForProject: mocks.listSecrets, revokeForProject: mocks.revokeSecret },
  agents: { list: mocks.listAgents },
} }));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div>{actions}{children}</div> }));
vi.mock("../../../../components/aria/StudioModal", () => ({ StudioDialogModal: ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) => isOpen ? <div role="dialog">{children}</div> : null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function automation(id: string): ControllerAutomation {
  return {
    id, projectId: mocks.projectId, userId: mocks.userId, name: `Automation ${id}`,
    promptText: "Check the build", metadata: {}, scheduleKind: "hourly", runAt: null,
    intervalHours: 24, byDay: [], byHour: null, byMinute: null, timezone: "UTC",
    runtimeMode: "auto", runtimeProvider: null, conversationId: null,
    silentWhenNothingToReport: false, status: "active", lockedUntil: null,
    lastRunAt: null, nextRunAt: null, lastError: null, createdAt: "2026-09-06", updatedAt: "2026-09-06",
  };
}
function secret(id: string): ControllerProjectSecret {
  return { id, name: `SECRET_${id}`, description: null, agentIds: [], agentHandles: [],
    lastUsedAt: null, revokedAt: null, createdAt: "2026-09-06", updatedAt: "2026-09-06" };
}

describe("settings loading states", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    mocks.projectId = "project-a";
    mocks.userId = "user-a";
    mocks.listAutomations.mockReset();
    mocks.listSecrets.mockReset();
    mocks.listAgents.mockReset().mockResolvedValue({ success: true, agents: [] });
    mocks.revokeSecret.mockReset();
    mocks.showStatus.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(children: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>));
  }
  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  async function retry() {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    await settle();
  }

  it("shows an automation load error with Retry instead of a false empty state", async () => {
    mocks.listAutomations.mockRejectedValueOnce(new Error('fetch automations failed (503): {"error":"private controller detail"}'));
    await render(<AutomationsPanel />);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load automations. Try again.");
    expect(container.textContent).not.toContain("private controller detail");
    expect(container.textContent).not.toContain("No automations yet");
    mocks.listAutomations.mockResolvedValueOnce([automation("a")]);
    await retry();
    expect(container.textContent).toContain("Automation a");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps automation rows during pending and failed transient refreshes", async () => {
    mocks.listAutomations.mockResolvedValueOnce([automation("a")]);
    await render(<AutomationsPanel />);
    await settle();
    const refresh = deferred<ControllerAutomation[]>();
    mocks.listAutomations.mockReturnValueOnce(refresh.promise);
    await act(async () => { void queryClient.refetchQueries({ queryKey: ["project-automations", "user-a", "project-a"] }); });
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Refreshing automations…");
    expect(container.textContent).toContain("Automation a");
    await act(async () => refresh.reject(new Error("Network unavailable")));
    await settle();
    expect(container.textContent).toContain("Automation a");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't refresh automations. Your saved list is still shown.");
  });

  it("evicts revoked automation records so later transient failures cannot restore them", async () => {
    mocks.listAutomations.mockResolvedValueOnce([automation("a")]);
    await render(<AutomationsPanel />);
    await settle();
    mocks.listAutomations.mockRejectedValueOnce(new ControllerApiError({ status: 403, message: "Access revoked", code: null, details: null }));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["project-automations", "user-a", "project-a"] }); });
    await settle();
    expect(container.textContent).not.toContain("Automation a");
    expect(container.textContent).not.toContain("No automations yet");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("You no longer have access to these automations.");
    mocks.listAutomations.mockRejectedValueOnce(new Error("Network unavailable"));
    await retry();
    expect(container.textContent).not.toContain("Automation a");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't refresh automations. Try again.");
  });

  it("ignores an old project's late automation response and closes its draft", async () => {
    const old = deferred<ControllerAutomation[]>();
    mocks.listAutomations.mockReturnValueOnce(old.promise).mockResolvedValueOnce([automation("b")]);
    await render(<AutomationsPanel />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="automations-create-button"]')!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    mocks.projectId = "project-b";
    await render(<AutomationsPanel />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => old.resolve([automation("a")]));
    await settle();
    expect(container.textContent).toContain("Automation b");
    expect(container.textContent).not.toContain("Automation a");
  });

  it("does not reuse another user's automation cache", async () => {
    mocks.listAutomations.mockResolvedValueOnce([automation("a")]);
    await render(<AutomationsPanel />);
    await settle();
    mocks.userId = "user-b";
    mocks.listAutomations.mockReturnValueOnce(new Promise(() => {}));
    await render(<AutomationsPanel />);
    expect(container.textContent).not.toContain("Automation a");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading automations…");
  });

  it("shows secret loading and failure honestly and retries successfully", async () => {
    const initial = deferred<{ success: boolean; secrets: ControllerProjectSecret[]; error?: string }>();
    mocks.listSecrets.mockReturnValueOnce(initial.promise);
    await render(<ProjectSecretsCard projectId="project-a" />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading secrets…");
    expect(container.textContent).not.toContain("No secrets yet");
    await act(async () => initial.resolve({ success: false, secrets: [], error: 'Unable to load secrets (503): {"error":"private controller detail"}' }));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load secrets. Try again.");
    expect(container.textContent).not.toContain("private controller detail");
    expect(container.textContent).not.toContain("No secrets yet");
    mocks.listSecrets.mockResolvedValueOnce({ success: true, secrets: [secret("A")] });
    await retry();
    expect(container.textContent).toContain("SECRET_A");
  });

  it("keeps secret rows during refresh but withholds metadata after protected read failure", async () => {
    mocks.listSecrets.mockResolvedValueOnce({ success: true, secrets: [secret("A")] });
    await render(<ProjectSecretsCard projectId="project-a" />);
    await settle();
    const refresh = deferred<{ success: boolean; secrets: ControllerProjectSecret[]; error?: string }>();
    mocks.listSecrets.mockReturnValueOnce(refresh.promise);
    await act(async () => { void queryClient.refetchQueries({ queryKey: ["project-secrets", "user-a", "project-a"] }); });
    await settle();
    expect(container.textContent).toContain("SECRET_A");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Refreshing secrets…");
    await act(async () => refresh.resolve({ success: false, secrets: [], error: "Access denied" }));
    await settle();
    expect(container.textContent).not.toContain("SECRET_A");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't refresh secrets. Try again.");
  });

  it("does not show old-project secrets or agent names after late requests finish", async () => {
    const old = deferred<{ success: boolean; secrets: ControllerProjectSecret[] }>();
    mocks.listSecrets.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ success: true, secrets: [secret("B")] });
    await render(<ProjectSecretsCard projectId="project-a" />);
    await render(<ProjectSecretsCard projectId="project-b" />);
    await settle();
    await act(async () => old.resolve({ success: true, secrets: [secret("A")] }));
    await settle();
    expect(container.textContent).toContain("SECRET_B");
    expect(container.textContent).not.toContain("SECRET_A");
  });

  it("invalidates the original secret cache after a mutation finishes in another project", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.listSecrets.mockResolvedValueOnce({ success: true, secrets: [secret("A")] })
      .mockResolvedValueOnce({ success: true, secrets: [secret("B")] });
    const revoke = deferred<{ success: boolean }>();
    mocks.revokeSecret.mockReturnValueOnce(revoke.promise);
    await render(<ProjectSecretsCard projectId="project-a" />);
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="project-secret-revoke-A"]')!.click());
    await render(<ProjectSecretsCard projectId="project-b" />);
    await settle();
    await act(async () => revoke.resolve({ success: true }));
    expect(queryClient.getQueryState(["project-secrets", "user-a", "project-a"])?.isInvalidated).toBe(true);
    expect(container.textContent).toContain("SECRET_B");
    expect(mocks.showStatus).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockRestore();
  });

  it("refreshes a newly mounted original project when its earlier mutation finishes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let revoked = false;
    mocks.listSecrets.mockImplementation(async (projectId: string) => ({ success: true,
      secrets: projectId === "project-b" ? [secret("B")] : revoked ? [] : [secret("A")],
    }));
    const revoke = deferred<{ success: boolean }>();
    mocks.revokeSecret.mockReturnValueOnce(revoke.promise);
    await render(<ProjectSecretsCard projectId="project-a" />);
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="project-secret-revoke-A"]')!.click());
    await render(<ProjectSecretsCard projectId="project-b" />);
    await settle();
    await render(<ProjectSecretsCard projectId="project-a" />);
    await settle();
    expect(container.textContent).toContain("SECRET_A");
    revoked = true;
    await act(async () => revoke.resolve({ success: true }));
    await settle();
    expect(container.textContent).not.toContain("SECRET_A");
    expect(container.textContent).toContain("No secrets yet");
    expect(mocks.showStatus).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockRestore();
  });
});
