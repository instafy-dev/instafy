// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";

// Sign in again, end to end in Studio: the real Connections list, connect
// flow, connect dialog and device sign-in, in front of a small stand-in for
// the controller. Like the controller, the stand-in makes the replacement when
// the sign-in finishes: of the same ChatGPT account, the new sign-in takes the
// old one's place, name and default, and the old one is retired; of another,
// it is added beside it. Studio itself retires nothing.

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
  // The ChatGPT account the person signs in to.
  account: "acct_person",
  // A controller from before Sign in again, which replaces nothing and says nothing.
  older: false,
  // Another session of Sign in again for the same row finished first.
  retiredMeanwhile: false,
  calls: [] as string[],
}));
const desktop = vi.hoisted(() => ({ available: false }));

function signInRow(id: string, label: string, isDefault: boolean, account: string): Row {
  return {
    id,
    kind: "codex_auth_json",
    label,
    isDefault,
    metadata: { source: "device_code", account_id: account },
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
// Desktop's import off unless a case turns it on.
vi.mock("../desktopCodexAuthJson", () => ({
  canUseDesktopCodexAuthJson: () => desktop.available,
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
    controller.account = "acct_person";
    controller.older = false;
    controller.retiredMeanwhile = false;
    controller.calls = [];
    desktop.available = false;
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
    // The person approved the code, and the controller saved the sign-in in
    // one transaction: in the old one's place when it is live and of the same
    // account, otherwise as a new one beside it.
    let outcome: { replaced?: boolean; notReplacedReason?: "different_account" | "gone" } = {};
    credentials.getDeviceAuthStatus.mockImplementation(async () => {
      if (!controller.rows.some((row) => row.id === "cred-fresh")) {
        if (controller.retiredMeanwhile) {
          for (const row of controller.rows) {
            row.revokedAt = "2026-11-22T11:59:00.000Z";
          }
          controller.rows.push(signInRow("cred-first", "ChatGPT", true, controller.account));
        }
        const old = controller.rows.find((row) => row.id === controller.replaces && !row.revokedAt);
        if (controller.older) {
          controller.rows.push(signInRow("cred-fresh", "ChatGPT", false, controller.account));
          outcome = {};
        } else if (old && old.metadata.account_id === controller.account) {
          controller.rows.push(signInRow("cred-fresh", old.label ?? "ChatGPT", old.isDefault, controller.account));
          old.isDefault = false;
          old.revokedAt = "2026-11-22T12:00:00.000Z";
          outcome = { replaced: true };
        } else {
          controller.rows.push(signInRow("cred-fresh", "ChatGPT 2", false, controller.account));
          outcome = controller.replaces
            ? { replaced: false, notReplacedReason: old ? "different_account" : "gone" }
            : {};
        }
        controller.calls.push("save");
      }
      return {
        success: true,
        sessionId: "session-1",
        provider: "codex",
        status: "completed",
        credentialId: "cred-fresh",
        ...outcome,
      };
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

  async function signInAgainOn(id: string) {
    await act(async () => root.render(<CredentialsSettingsCard />));
    await until("the sign-in's row", () => liveRows().length === controller.rows.length);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-testid="credentials-connection-sign-in-again-${id}"]`)!.click();
    });
    const signIn = () => document.querySelector<HTMLButtonElement>('[data-testid="credentials-connect-codex"]');
    await until("the ChatGPT step", () => signIn() !== null);
    // Only the device sign-in, so every Sign in again is the controller's
    // replacement: no Desktop import, no auth.json, no typed name.
    expect(document.querySelector('[data-testid="credentials-sign-in-again-note"]')?.textContent).toContain("ChatGPT");
    expect(document.querySelector('[data-testid="credentials-connect-codex-browser-toggle"]')).toBeNull();
    expect(document.querySelector('[data-testid="credentials-codex-auth-json-input"]')).toBeNull();
    expect(document.querySelector('[data-testid="credentials-codex-label-input"]')).toBeNull();
    expect(signIn()?.textContent).not.toContain("Use local Codex login");
    await act(async () => signIn()!.click());
    await until("the sign-in to finish", () => controller.calls.includes("save") && !signIn());
  }

  it.each([
    ["the default", true],
    ["not the default", false],
  ])("on a sign-in that is %s leaves one live connection of its name, retired by the controller", async (_case, wasDefault) => {
    controller.rows = [signInRow("cred-stale", "ChatGPT", wasDefault, "acct_person")];
    await signInAgainOn("cred-stale");
    await until("the list to reload", () => liveRows().length === 1 && liveRows()[0].dataset.testid === "credentials-connection-row-cred-fresh");

    expect(credentials.startDeviceAuth).toHaveBeenCalledExactlyOnceWith("codex", { replacesCredentialId: "cred-stale" });
    // Studio only tested the new sign-in; it promoted and retired nothing.
    expect(controller.calls).toEqual(["save", "test cred-fresh"]);
    const live = controller.rows.filter((row) => !row.revokedAt);
    expect(live.map((row) => [row.id, row.label, row.isDefault])).toEqual([["cred-fresh", "ChatGPT", wasDefault]]);
    expect(liveRows()[0].textContent).not.toContain("ChatGPT 2");
    expect(showStatus).toHaveBeenCalledWith("Signed in again.", "success", 3500);
  });

  it("with Desktop's import on this computer still offers only the device sign-in", async () => {
    desktop.available = true;
    controller.rows = [signInRow("cred-stale", "ChatGPT", true, "acct_person")];
    await signInAgainOn("cred-stale");
    await until("the list to reload", () => liveRows().length === 1);
    expect(controller.calls).toEqual(["save", "test cred-fresh"]);
  });

  it("against a controller that does not replace, says the old one is still there and takes no default", async () => {
    controller.rows = [signInRow("cred-stale", "ChatGPT", true, "acct_person")];
    controller.older = true;
    await signInAgainOn("cred-stale");
    await until("the list to reload", () => liveRows().length === 2);
    expect(controller.calls).toEqual(["save", "test cred-fresh"]);
    expect(controller.rows.find((row) => row.id === "cred-stale")?.isDefault).toBe(true);
    expect(showStatus).toHaveBeenCalledWith(
      "That sign-in was added as a new connection. The old one is still here.",
      "warning",
      6500,
      undefined,
    );
  });

  it("whose row another session replaced first leaves the default with that replacement", async () => {
    controller.rows = [signInRow("cred-stale", "ChatGPT", true, "acct_person")];
    controller.retiredMeanwhile = true;
    await signInAgainOn("cred-stale");
    await until("the list to reload", () => liveRows().length === 2);
    // Saved fresh beside the first session's replacement, which keeps the default.
    expect(controller.calls).toEqual(["save", "test cred-fresh"]);
    expect(
      controller.rows.filter((row) => !row.revokedAt).map((row) => [row.id, row.isDefault]),
    ).toEqual([
      ["cred-first", true],
      ["cred-fresh", false],
    ]);
    expect(showStatus).toHaveBeenCalledWith("ChatGPT credentials connected.", "success", 3500);
  });

  it("of another ChatGPT account adds a connection and keeps the old one", async () => {
    controller.rows = [signInRow("cred-stale", "ChatGPT", true, "acct_person")];
    controller.account = "acct_other";
    await signInAgainOn("cred-stale");
    await until("the list to reload", () => liveRows().length === 2);

    expect(controller.calls).toEqual(["save", "test cred-fresh"]);
    expect(controller.rows.map((row) => [row.id, row.label, row.isDefault, row.revokedAt])).toEqual([
      ["cred-stale", "ChatGPT", true, null],
      ["cred-fresh", "ChatGPT 2", false, null],
    ]);
    expect(showStatus).toHaveBeenCalledWith(
      "That signed in to a different ChatGPT account, so it was added as a new connection. The old one is still here.",
      "warning",
      6500,
      undefined,
    );
  });
});
