// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";

// Sign in again, end to end in Studio: the real Connections list, connect
// flow, connect dialog and device sign-in, in front of a small stand-in for
// the controller. Like the controller, the stand-in saves a sign-in that
// names the one it replaces under that one's name.

type Row = {
  id: string;
  kind: string;
  label: string | null;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const controller = vi.hoisted(() => ({
  rows: [] as Row[],
  replaces: null as string | null,
  calls: [] as string[],
}));

function signInRow(id: string, label: string, isDefault: boolean): Row {
  return {
    id,
    kind: "codex_auth_json",
    label,
    isDefault,
    metadata: { source: "device_code", account_id: `acct_${id}` },
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const credentials = vi.hoisted(() => ({
  list: vi.fn(),
  getRequirements: vi.fn(),
  startDeviceAuth: vi.fn(),
  getDeviceAuthStatus: vi.fn(),
  cancelDeviceAuth: vi.fn(),
  test: vi.fn(),
  setDefault: vi.fn(),
  revoke: vi.fn(),
  createCodex: vi.fn(),
  clearDefault: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://127.0.0.1:8789",
  runtimeControllerEnabled: true,
  controllerClient: {
    agents: {
      list: async () => ({ success: true, agents: [] }),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    },
    credentials,
  },
}));
// The same objects on every render, as the real providers give: a new user
// each time would reload the list on every render.
const session = vi.hoisted(() => ({
  auth: { user: { id: "user-1", email: "person@example.test" } },
  tabs: { openPanelTab: () => {}, requestUrlPush: () => {} },
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => session.tabs }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => session.auth }));
const showStatus = vi.hoisted(() => vi.fn());
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus }) }));
vi.mock("../../../../lib/identityImages", () => ({ uploadIdentityImage: vi.fn() }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../AgentProfileModal", () => ({ AgentProfileModal: () => null }));
// The web's ChatGPT step: a device sign-in, no Desktop import.
vi.mock("../desktopCodexAuthJson", () => ({
  canUseDesktopCodexAuthJson: () => false,
  connectDesktopCodexAuthJson: vi.fn(),
  useDesktopCodexAuthJsonStatus: () => null,
  isLikelyDesktopDevice: () => false,
  shouldPromptForCodexAuthJsonUpload: () => false,
}));
vi.mock("../devServerCodexAuthJson", () => ({
  canUseDevServerCodexAuthJson: () => false,
  connectDevServerCodexAuthJson: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web", isNativePlatform: () => false } }));

async function settle(turns = 3) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function until(what: string, done: () => boolean) {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
    await settle(1);
  }
  if (!done()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

describe("Sign in again", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 640px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    vi.stubGlobal("CSS", { escape: (value: string) => value, supports: () => false });
    controller.rows = [];
    controller.replaces = null;
    controller.calls = [];
    showStatus.mockReset();
    credentials.list.mockImplementation(async () => ({
      success: true,
      credentials: controller.rows.map((row) => ({ ...row })),
    }));
    credentials.getRequirements.mockImplementation(async () => ({
      success: true,
      requiresUserCredentials: true,
      proxyBackend: "codex",
      hasDefaultCredential: controller.rows.some((row) => row.isDefault && !row.revokedAt),
      managedAi: null,
    }));
    credentials.startDeviceAuth.mockImplementation(
      async (_provider: string, params?: { replacesCredentialId?: string | null }) => {
        controller.replaces = params?.replacesCredentialId ?? null;
        return {
          success: true,
          sessionId: "session-1",
          provider: "codex",
          verificationUrl: "https://auth.example.test/codex/device",
          userCode: "INERT-CODE",
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          pollIntervalSeconds: 5,
        };
      },
    );
    // The person approved the code: the controller saves the sign-in, under
    // the replaced sign-in's name while that one is live.
    credentials.getDeviceAuthStatus.mockImplementation(async () => {
      if (!controller.rows.some((row) => row.id === "cred-fresh")) {
        const replaced = controller.rows.find((row) => row.id === controller.replaces && !row.revokedAt);
        controller.rows.push(signInRow("cred-fresh", replaced?.label ?? "ChatGPT 2", false));
        controller.calls.push("save");
      }
      return { success: true, sessionId: "session-1", provider: "codex", status: "completed", credentialId: "cred-fresh" };
    });
    credentials.cancelDeviceAuth.mockResolvedValue({ success: true });
    credentials.test.mockImplementation(async (id: string) => {
      controller.calls.push(`test ${id}`);
      return { success: true, ok: true };
    });
    credentials.setDefault.mockImplementation(async (id: string) => {
      controller.calls.push(`setDefault ${id}`);
      for (const row of controller.rows) {
        row.isDefault = row.id === id;
      }
      return { success: true, credentialId: id, isDefault: true };
    });
    credentials.revoke.mockImplementation(async (id: string) => {
      controller.calls.push(`revoke ${id}`);
      const row = controller.rows.find((entry) => entry.id === id);
      if (row) {
        row.revokedAt = "2026-11-22T12:00:00.000Z";
        row.isDefault = false;
      }
      return { success: true };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const liveRows = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="credentials-connection-row-cred-"]'));

  it.each([
    ["the default", true, ["save", "test cred-fresh", "setDefault cred-fresh", "revoke cred-stale"]],
    ["not the default", false, ["save", "test cred-fresh", "revoke cred-stale"]],
  ])("on a ChatGPT sign-in that is %s ends with one live connection named ChatGPT", async (_case, wasDefault, calls) => {
    controller.rows = [signInRow("cred-stale", "ChatGPT", wasDefault)];
    await act(async () => root.render(<CredentialsSettingsCard />));
    await until("the sign-in's row", () => liveRows().length === 1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="credentials-connection-sign-in-again-cred-stale"]')!.click();
    });
    // Straight at the ChatGPT step, with nothing to choose first.
    const signIn = () => document.querySelector<HTMLButtonElement>('[data-testid="credentials-connect-codex"]');
    await until("the ChatGPT step", () => signIn() !== null);
    await act(async () => signIn()!.click());

    await until("the replacement to finish", () => controller.calls.includes("revoke cred-stale") && !signIn());
    await until("the list to reload", () => liveRows().length === 1 && liveRows()[0].dataset.testid === "credentials-connection-row-cred-fresh");

    expect(credentials.startDeviceAuth).toHaveBeenCalledExactlyOnceWith("codex", { replacesCredentialId: "cred-stale" });
    expect(controller.calls).toEqual(calls);
    const live = controller.rows.filter((row) => !row.revokedAt);
    expect(live.map((row) => [row.id, row.label, row.isDefault])).toEqual([["cred-fresh", "ChatGPT", wasDefault]]);
    const row = liveRows()[0];
    expect(row.textContent).toContain("ChatGPT");
    expect(row.textContent).not.toContain("ChatGPT 2");
    expect(showStatus).toHaveBeenCalledWith(
      "Connection replaced. Agents pinned to the old one now use the default.",
      "success",
      4500,
    );
    expect(showStatus).not.toHaveBeenCalledWith("ChatGPT credentials connected.", "success", 3500);
  });
});
