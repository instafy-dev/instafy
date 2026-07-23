// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCredentialsConnectFlow } from "../useCredentialsConnectFlow";

const controllerMocks = vi.hoisted(() => ({
  createCodex: vi.fn(),
  revoke: vi.fn(),
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
  let loadCredentials: ReturnType<typeof vi.fn>;
  let notifyAiConfigChanged: ReturnType<typeof vi.fn>;
  let showStatus: ReturnType<typeof vi.fn>;

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
