// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontendTurnEngineYourAiRowProps } from "../CredentialsSettingsCard";

const mocks = vi.hoisted(() => ({
  // One object, as the real provider keeps it: the card's loads follow its identity.
  user: { id: "user-1", email: "a@instafy.test" },
  showStatus: vi.fn(),
  connectFlow: {
    canManageAiConnections: true,
    openConnectModal: vi.fn(),
    openConnectModalAtStep: vi.fn(),
    openConnectModalToReplace: vi.fn(),
    connectModalProps: {},
  },
  rowProps: [] as FrontendTurnEngineYourAiRowProps[],
  fetchStatus: vi.fn(),
  resolveRequestContext: vi.fn(),
}));

// One engine that contributes a Your AI row, and one that contributes none:
// the settings card renders whatever the engines contribute, and names none.
vi.mock("../../../../features/applicationFrontendFeatureComposition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../features/applicationFrontendFeatureComposition")>();
  function EngineRow(props: FrontendTurnEngineYourAiRowProps) {
    mocks.rowProps.push(props);
    return <div data-testid="engine-your-ai-row">Engine on this computer</div>;
  }
  return {
    ...actual,
    APPLICATION_FRONTEND_FEATURES: {
      ...actual.APPLICATION_FRONTEND_FEATURES,
      turnEngines: [
        { id: "engine-with-row", ComposerBridge: () => null, YourAiRow: EngineRow },
        { id: "engine-without-row", ComposerBridge: () => null },
      ],
    },
  };
});

vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../../../lib/identityImages", () => ({ uploadIdentityImage: vi.fn() }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://127.0.0.1:8789",
  runtimeControllerEnabled: true,
  controllerClient: {
    agents: {
      create: vi.fn(),
      list: vi.fn(async () => ({ success: true, agents: [] })),
      remove: vi.fn(),
      update: vi.fn(),
    },
    credentials: {
      clearDefault: vi.fn(),
      createCodex: vi.fn(),
      getRequirements: vi.fn(async () => ({
        success: true,
        requiresUserCredentials: true,
        proxyBackend: "codex",
        hasDefaultCredential: false,
        managedAi: null,
      })),
      list: vi.fn(async () => ({ success: true, credentials: [] })),
      revoke: vi.fn(),
      setDefault: vi.fn(),
      test: vi.fn(),
    },
    runtimes: { fetchStatus: mocks.fetchStatus },
    core: { resolveRequestContext: mocks.resolveRequestContext },
  },
}));
// The connect modal is its own surface, which no turn engine contributes to
// (packages/frontend/tests/playwright/smoke/credential-device-auth-generic.spec.ts).
vi.mock("../CredentialsConnectModal", () => ({ CredentialsConnectModal: () => null }));
vi.mock("../AgentProfileModal", () => ({ AgentProfileModal: () => null }));
vi.mock("../useCredentialsConnectFlow", () => ({ useCredentialsConnectFlow: () => mocks.connectFlow }));

import { CredentialsSettingsCard } from "../CredentialsSettingsCard";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("a turn engine's row in Your AI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    mocks.rowProps.length = 0;
    mocks.fetchStatus.mockReset().mockResolvedValue(null);
    mocks.resolveRequestContext.mockReset().mockResolvedValue({ baseUrl: "https://controller.example.test " });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("sits among the connections, never in the connect modal, and is no connection to make the default", async () => {
    await act(async () => {
      root.render(<CredentialsSettingsCard section="connections" />);
      await flush();
    });
    const rows = container.querySelectorAll('[data-testid="engine-your-ai-row"]');
    expect(rows).toHaveLength(1);
    // Rendered by the card itself: the connect modal is a separate surface.
    expect(container.querySelector('[data-testid="credentials-list-codex"] [data-testid="engine-your-ai-row"]')).toBeNull();
    expect(rows[0]?.closest("li")).toBeNull();
    expect(rows[0]?.textContent).not.toMatch(/default/i);
  });

  it("gives the row the space status and the controller this Studio talks to", async () => {
    await act(async () => {
      root.render(<CredentialsSettingsCard section="connections" />);
      await flush();
    });
    const props = mocks.rowProps.at(-1)!;
    await props.fetchRuntimeStatus({ projectId: "project-1", quietOnAbort: true });
    expect(mocks.fetchStatus).toHaveBeenCalledWith({ projectId: "project-1", quietOnAbort: true });
    await expect(props.resolveControllerUrl()).resolves.toBe("https://controller.example.test");
  });

  it("stays out of the agents view", async () => {
    await act(async () => {
      root.render(<CredentialsSettingsCard section="agents" />);
      await flush();
    });
    expect(container.querySelector('[data-testid="engine-your-ai-row"]')).toBeNull();
  });
});
