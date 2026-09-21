// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useCredentialsConnectFlow } from "../useCredentialsConnectFlow";

const controllerMocks = vi.hoisted(() => ({
  createCodex: vi.fn(),
  revoke: vi.fn(),
  setDefault: vi.fn(),
  test: vi.fn(),
}));

const deviceAuthMocks = vi.hoisted(() => ({
  begin: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://controller.test",
  runtimeControllerEnabled: true,
  controllerClient: {
    credentials: controllerMocks,
  },
}));

vi.mock("../desktopCodexAuthJson", () => ({
  canUseDesktopCodexAuthJson: () => false,
  selectDesktopCodexAuthJson: vi.fn(),
  useDesktopCodexAuthJsonStatus: () => null,
}));

vi.mock("../device-auth/useDeviceAuthFlow", () => ({
  useDeviceAuthFlow: () => ({
    session: null,
    provider: null,
    error: null,
    begin: deviceAuthMocks.begin,
    cancel: deviceAuthMocks.cancel,
    reset: deviceAuthMocks.reset,
  }),
}));

type HookOptions = Parameters<typeof useCredentialsConnectFlow>[0];

let captured: ReturnType<typeof useCredentialsConnectFlow> | null = null;

function Harness({ options }: { options: HookOptions }) {
  captured = useCredentialsConnectFlow(options);
  return (
    <div>
      <span data-testid="modal-open">{String(captured.connectModalProps.connectModalOpen)}</span>
      <span data-testid="openai-key">{captured.connectModalProps.openaiApiKeyDraft}</span>
      <span data-testid="deepseek-key">{captured.connectModalProps.deepseekApiKeyDraft}</span>
    </div>
  );
}

describe("useCredentialsConnectFlow API-key verification", () => {
  let container: HTMLDivElement;
  let root: Root;
  let loadCredentials: Mock;
  let notifyAiConfigChanged: Mock;
  let showStatus: Mock;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    controllerMocks.createCodex.mockResolvedValue({
      success: true,
      credentialId: "credential-1",
    });
    controllerMocks.revoke.mockResolvedValue({ success: true });
    loadCredentials = vi.fn().mockResolvedValue(undefined);
    notifyAiConfigChanged = vi.fn();
    showStatus = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <Harness
          options={{
            userPresent: true,
            loadCredentials,
            notifyAiConfigChanged,
            showStatus,
            formatCredentialTestFailureMessage: (raw) =>
              raw ? `Readable: ${raw}` : null,
          }}
        />,
      );
    });
    await act(async () => {
      captured?.openConnectModalAtStep("deepseek");
      captured?.connectModalProps.onDeepseekApiKeyDraftChange(" invalid-key ");
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    captured = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("returns direct provider setup to its caller and clears cancelled key drafts", async () => {
    await act(async () => captured?.openConnectModalAtStep("deepseek", { returnOnBack: true }));
    expect(captured?.connectModalProps.connectModalStep).toBe("deepseek");
    await act(async () => captured?.connectModalProps.onBack());
    expect(captured?.connectModalProps.connectModalOpen).toBe(false);
    expect(captured?.connectModalProps.deepseekApiKeyDraft).toBe("");
    expect(controllerMocks.createCodex).not.toHaveBeenCalled();

    // Entry points elsewhere in Studio retain their provider chooser on Back.
    await act(async () => captured?.openConnectModal());
    await act(async () => captured?.connectModalProps.onStepChange("openai"));
    await act(async () => captured?.connectModalProps.onBack());
    expect(captured?.connectModalProps.connectModalOpen).toBe(true);
    expect(captured?.connectModalProps.connectModalStep).toBe("picker");
  });

  it("keeps the modal and draft open when the verification request fails", async () => {
    controllerMocks.test.mockResolvedValue({
      success: false,
      error: "provider unavailable",
    });

    let connected = true;
    await act(async () => {
      connected =
        (await captured?.connectModalProps.onConnectApiKey("deepseek")) ?? true;
    });

    expect(connected).toBe(false);
    expect(controllerMocks.revoke).toHaveBeenCalledWith("credential-1");
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(notifyAiConfigChanged).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith(
      "Readable: provider unavailable",
      "error",
      6500,
    );
    expect(container.querySelector('[data-testid="modal-open"]')?.textContent).toBe("true");
    expect(container.querySelector('[data-testid="deepseek-key"]')?.textContent).toBe(
      " invalid-key ",
    );
  });

  it("does not advance when the provider rejects the saved key", async () => {
    controllerMocks.test.mockResolvedValue({
      success: true,
      ok: false,
      output: "invalid API key",
    });

    let connected = true;
    await act(async () => {
      connected =
        (await captured?.connectModalProps.onConnectApiKey("deepseek")) ?? true;
    });

    expect(connected).toBe(false);
    expect(controllerMocks.revoke).toHaveBeenCalledWith("credential-1");
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(notifyAiConfigChanged).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith(
      "Credential verification failed: Readable: invalid API key",
      "error",
      7000,
    );
    expect(container.querySelector('[data-testid="modal-open"]')?.textContent).toBe("true");
  });

  it("reports success and advances only after verification passes", async () => {
    controllerMocks.test.mockResolvedValue({ success: true, ok: true });

    let connected = false;
    await act(async () => {
      connected =
        (await captured?.connectModalProps.onConnectApiKey("deepseek")) ?? false;
    });

    expect(connected).toBe(true);
    expect(controllerMocks.revoke).not.toHaveBeenCalled();
    expect(loadCredentials).toHaveBeenCalledWith({ silent: true });
    expect(notifyAiConfigChanged).toHaveBeenCalledWith("deepseek_api_key_connected");
    expect(showStatus).toHaveBeenLastCalledWith(
      "Credential verified.",
      "success",
      3500,
    );
    expect(container.querySelector('[data-testid="deepseek-key"]')?.textContent).toBe("");
  });

  it("saves and verifies a plain OpenAI API key with the OpenAI provider", async () => {
    controllerMocks.test.mockResolvedValue({ success: true, ok: true });
    await act(async () => {
      captured?.openConnectModalAtStep("openai");
      captured?.connectModalProps.onOpenaiApiKeyDraftChange(" unit-test-value ");
    });

    let connected = false;
    await act(async () => {
      connected =
        (await captured?.connectModalProps.onConnectApiKey("openai")) ?? false;
    });

    expect(connected).toBe(true);
    expect(controllerMocks.createCodex).toHaveBeenCalledWith({
      authJson: { OPENAI_API_KEY: "unit-test-value" },
      label: "OpenAI",
      provider: "openai",
    });
    expect(controllerMocks.test).toHaveBeenCalledWith("credential-1");
    expect(controllerMocks.revoke).not.toHaveBeenCalled();
    expect(loadCredentials).toHaveBeenCalledWith({ silent: true });
    expect(notifyAiConfigChanged).toHaveBeenCalledWith("openai_api_key_connected");
    expect(showStatus).toHaveBeenLastCalledWith(
      "Credential verified.",
      "success",
      3500,
    );
    expect(container.querySelector('[data-testid="openai-key"]')?.textContent).toBe("");
  });
});

describe("useCredentialsConnectFlow replace ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let showStatus: Mock;
  let isDefault: Mock;
  let calls: string[];

  async function mount() {
    await act(async () => {
      root.render(
        <Harness
          options={{
            userPresent: true,
            loadCredentials: vi.fn().mockResolvedValue(undefined),
            notifyAiConfigChanged: vi.fn(),
            showStatus,
            formatCredentialTestFailureMessage: (raw) => (raw ? `Readable: ${raw}` : null),
            isCredentialDefault: isDefault as unknown as (id: string) => boolean,
          }}
        />,
      );
    });
  }

  async function replaceWith(step: "openai" | "deepseek" = "deepseek") {
    await act(async () => {
      captured?.openConnectModalToReplace({ id: "old-credential", label: "Old key" }, step);
      captured?.connectModalProps.onDeepseekApiKeyDraftChange("sk-new-key");
    });
    await act(async () => {
      await captured?.connectModalProps.onConnectApiKey("deepseek");
    });
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    calls = [];
    controllerMocks.createCodex.mockImplementation(async () => {
      calls.push("create");
      return { success: true, credentialId: "new-credential" };
    });
    controllerMocks.test.mockImplementation(async () => {
      calls.push("test");
      return { success: true, ok: true };
    });
    controllerMocks.setDefault.mockImplementation(async () => {
      calls.push("setDefault");
      return { success: true };
    });
    controllerMocks.revoke.mockImplementation(async () => {
      calls.push("revoke");
      return { success: true };
    });
    isDefault = vi.fn().mockReturnValue(false);
    showStatus = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await mount();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    captured = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("creates and verifies before retiring anything", async () => {
    // Revoking first would strand the workspace: revoke_my_credential clears
    // is_default and promotes nothing.
    await replaceWith();
    expect(calls).toEqual(["create", "test", "revoke"]);
  });

  it("never lets the replacement default itself into place", async () => {
    // The controller auto-defaults a new credential when the user has none,
    // which would flip a managed-AI user into BYOC behind their back.
    await replaceWith();
    expect(controllerMocks.createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ makeDefault: false }),
    );
  });

  it("promotes the replacement when the target is the live default", async () => {
    isDefault.mockReturnValue(true);
    await replaceWith();
    expect(calls).toEqual(["create", "test", "setDefault", "revoke"]);
    expect(controllerMocks.setDefault).toHaveBeenCalledWith("new-credential");
  });

  it("decides promotion when it finishes, not when the button was pressed", async () => {
    // The default can move while the modal is open — another row's "Make
    // default", the chat wizard, a second tab. Reading a click-time snapshot
    // would retire the live default and leave the workspace with none.
    isDefault.mockReturnValue(false);
    await act(async () => {
      captured?.openConnectModalToReplace({ id: "old-credential", label: "Old key" }, "deepseek");
      captured?.connectModalProps.onDeepseekApiKeyDraftChange("sk-new-key");
    });
    isDefault.mockReturnValue(true);
    await act(async () => {
      await captured?.connectModalProps.onConnectApiKey("deepseek");
    });
    expect(calls).toContain("setDefault");
    expect(calls.indexOf("setDefault")).toBeLessThan(calls.indexOf("revoke"));
  });

  it("keeps the old credential when promotion fails", async () => {
    isDefault.mockReturnValue(true);
    controllerMocks.setDefault.mockImplementation(async () => {
      calls.push("setDefault");
      return { success: false, error: "nope" };
    });
    await replaceWith();
    expect(calls).not.toContain("revoke");
    expect(showStatus).toHaveBeenCalledWith(
      expect.stringContaining("could not be made the default"),
      "warning",
      expect.any(Number),
    );
  });

  it("says so when the old credential could not be removed", async () => {
    controllerMocks.revoke.mockImplementation(async () => {
      calls.push("revoke");
      return { success: false, error: "nope" };
    });
    await replaceWith();
    expect(showStatus).toHaveBeenCalledWith(
      expect.stringContaining("could not be removed"),
      "warning",
      expect.any(Number),
    );
  });

  it("abandons the replace when the reader switches provider", async () => {
    // A replace opened on one provider that lands on another must not retire
    // the first provider's healthy credential.
    await act(async () => {
      captured?.openConnectModalToReplace({ id: "old-credential", label: "Old key" }, "gemini");
    });
    await act(async () => {
      captured?.connectModalProps.onStepChange("deepseek");
      captured?.connectModalProps.onDeepseekApiKeyDraftChange("sk-new-key");
    });
    await act(async () => {
      await captured?.connectModalProps.onConnectApiKey("deepseek");
    });
    expect(calls).toEqual(["create", "test"]);
    expect(controllerMocks.revoke).not.toHaveBeenCalled();
  });

  it("does not retire anything when the new key fails verification", async () => {
    controllerMocks.test.mockImplementation(async () => {
      calls.push("test");
      return { success: true, ok: false, output: "bad key" };
    });
    await replaceWith();
    // The only revoke is the cleanup of the credential just created.
    expect(controllerMocks.revoke).toHaveBeenCalledWith("new-credential");
    expect(controllerMocks.revoke).not.toHaveBeenCalledWith("old-credential");
  });
});
