// @vitest-environment jsdom

import { act, type ChangeEvent } from "react";
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
  onCompleted: null as
    | ((input: { credentialId?: string | null }) => Promise<{ success: true; warning?: string }>)
    | null,
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://controller.test",
  runtimeControllerEnabled: true,
  controllerClient: {
    credentials: controllerMocks,
  },
}));

const desktopMocks = vi.hoisted(() => ({
  available: false,
  connect: vi.fn(),
}));

vi.mock("../desktopCodexAuthJson", () => ({
  canUseDesktopCodexAuthJson: () => desktopMocks.available,
  connectDesktopCodexAuthJson: desktopMocks.connect,
  selectDesktopCodexAuthJson: vi.fn(),
  useDesktopCodexAuthJsonStatus: () => null,
}));

vi.mock("../device-auth/useDeviceAuthFlow", () => ({
  useDeviceAuthFlow: (options: { onCompleted?: typeof deviceAuthMocks.onCompleted }) => {
    deviceAuthMocks.onCompleted = options.onCompleted ?? null;
    return {
    session: null,
    provider: null,
    error: null,
    begin: deviceAuthMocks.begin,
    cancel: deviceAuthMocks.cancel,
    reset: deviceAuthMocks.reset,
    };
  },
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

describe("useCredentialsConnectFlow default choice", () => {
  // A live test found a new space on "Codex on this computer" while the
  // included Instafy AI went unused: connecting an AI made it the default by
  // itself. Each caller now says whether the connection is the person's
  // choice of AI (true), must keep the current default (false), or leaves it
  // to the controller (undefined).
  let container: HTMLDivElement;
  let root: Root;

  async function mount(newConnectionDefault?: () => boolean | undefined) {
    await act(async () => {
      root.render(
        <Harness
          options={{
            userPresent: true,
            loadCredentials: vi.fn().mockResolvedValue(undefined),
            notifyAiConfigChanged: vi.fn(),
            showStatus: vi.fn(),
            formatCredentialTestFailureMessage: (raw) => raw ?? null,
            newConnectionDefault,
          }}
        />,
      );
    });
  }

  async function connectOpenAiKey() {
    await act(async () => {
      captured?.openConnectModalAtStep("openai");
      captured?.connectModalProps.onOpenaiApiKeyDraftChange("unit-test-value");
    });
    await act(async () => {
      await captured?.connectModalProps.onConnectApiKey("openai");
    });
  }

  async function completeChatGptLogin() {
    let result: { success: true; warning?: string } | undefined;
    await act(async () => {
      result = await deviceAuthMocks.onCompleted?.({ credentialId: "chatgpt-credential" });
    });
    return result;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    deviceAuthMocks.onCompleted = null;
    desktopMocks.available = false;
    desktopMocks.connect.mockResolvedValue({ success: true, credentialId: "desktop-credential" });
    controllerMocks.createCodex.mockResolvedValue({ success: true, credentialId: "credential-1" });
    controllerMocks.test.mockResolvedValue({ success: true, ok: true });
    controllerMocks.setDefault.mockResolvedValue({ success: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    captured = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps Instafy AI the default when the caller says so", async () => {
    await mount(() => false);
    await connectOpenAiKey();
    expect(controllerMocks.createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ makeDefault: false }),
    );
    expect(await completeChatGptLogin()).toEqual({ success: true });
    expect(controllerMocks.test).toHaveBeenCalledWith("chatgpt-credential");
    expect(controllerMocks.setDefault).not.toHaveBeenCalled();
  });

  it("makes the connection the default when it is the person's choice of AI", async () => {
    await mount(() => true);
    await connectOpenAiKey();
    expect(controllerMocks.createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ makeDefault: true }),
    );
    expect(await completeChatGptLogin()).toEqual({ success: true });
    expect(controllerMocks.setDefault).toHaveBeenCalledWith("chatgpt-credential");
  });

  it("reads the choice when the connection is saved, not when the modal opened", async () => {
    // Another tab switched the default to Instafy AI while the modal was open.
    let instafyAiIsDefault = false;
    await mount(() => (instafyAiIsDefault ? false : undefined));
    await act(async () => {
      captured?.openConnectModalAtStep("openai");
      captured?.connectModalProps.onOpenaiApiKeyDraftChange("unit-test-value");
    });
    instafyAiIsDefault = true;
    await act(async () => {
      await captured?.connectModalProps.onConnectApiKey("openai");
    });
    expect(controllerMocks.createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ makeDefault: false }),
    );
  });

  it("saves Codex on this computer without taking the default from Instafy AI", async () => {
    // The live test's space ran on exactly this connection. Desktop saves it
    // through its own bridge, which must carry the caller's choice too.
    desktopMocks.available = true;
    await mount(() => false);
    await act(async () => {
      await captured?.connectModalProps.onConnectCodex();
    });
    expect(desktopMocks.connect).toHaveBeenCalledWith({
      label: "Codex on this computer",
      makeDefault: false,
    });

    desktopMocks.connect.mockClear();
    await mount(() => true);
    await act(async () => {
      await captured?.connectModalProps.onConnectCodex();
    });
    expect(desktopMocks.connect).toHaveBeenCalledWith({
      label: "Codex on this computer",
      makeDefault: true,
    });
    expect(deviceAuthMocks.begin).not.toHaveBeenCalled();
  });

  it("leaves the default to the controller without a choice, as before", async () => {
    await mount();
    await connectOpenAiKey();
    expect(controllerMocks.createCodex.mock.calls[0]?.[0]).not.toHaveProperty("makeDefault");
    await completeChatGptLogin();
    expect(controllerMocks.setDefault).toHaveBeenCalledWith("chatgpt-credential");
  });
});

describe("useCredentialsConnectFlow replacements from the ChatGPT step", () => {
  // Sign in again on a ChatGPT sign-in's row opens the ChatGPT step to replace
  // it (openConnectModalToReplace(target, "codex"), exactly as the row calls
  // it). Whichever way the person signs in there, the new connection takes
  // the old one's name, becomes the default if the old one was, and the old
  // one is retired once the new one passed its test.
  let container: HTMLDivElement;
  let root: Root;
  let isDefault: Mock;
  let showStatus: Mock;
  let calls: string[];
  const signIn = { id: "old-chatgpt", label: "ChatGPT", savedLabel: "ChatGPT" };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    calls = [];
    desktopMocks.available = false;
    isDefault = vi.fn().mockReturnValue(true);
    showStatus = vi.fn();
    controllerMocks.createCodex.mockImplementation(async () => {
      calls.push("create");
      return { success: true, credentialId: "new-credential" };
    });
    desktopMocks.connect.mockImplementation(async () => {
      calls.push("create");
      return { success: true, credentialId: "new-credential", kind: "codex_auth_json", isDefault: false };
    });
    controllerMocks.test.mockImplementation(async () => {
      calls.push("test");
      return { success: true, ok: true };
    });
    controllerMocks.setDefault.mockImplementation(async (id: string) => {
      calls.push(`setDefault ${id}`);
      return { success: true };
    });
    controllerMocks.revoke.mockImplementation(async (id: string) => {
      calls.push(`revoke ${id}`);
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
    captured = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function mount() {
    await act(async () => {
      root.render(
        <Harness
          options={{
            userPresent: true,
            loadCredentials: vi.fn().mockResolvedValue(undefined),
            notifyAiConfigChanged: vi.fn(),
            showStatus,
            formatCredentialTestFailureMessage: (raw) => raw ?? null,
            isCredentialDefault: isDefault as unknown as (id: string) => boolean,
            newConnectionDefault: () => undefined,
          }}
        />,
      );
    });
  }

  async function signInAgain(target: typeof signIn = signIn) {
    await act(async () => captured?.openConnectModalToReplace(target, "codex"));
  }

  async function upload() {
    const file = {
      text: vi.fn().mockResolvedValue(JSON.stringify({ tokens: { access_token: "inert-access" } })),
    } as unknown as File;
    await act(async () => {
      captured?.connectModalProps.onUploadFile({
        target: { files: [file], value: "auth.json" },
      } as unknown as ChangeEvent<HTMLInputElement>);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it("starts the ChatGPT sign-in naming the one it replaces, then promotes and retires", async () => {
    await mount();
    await signInAgain();
    await act(async () => captured?.connectModalProps.onBeginDeviceAuth("codex"));
    expect(deviceAuthMocks.begin).toHaveBeenLastCalledWith({
      provider: "codex",
      replacesCredentialId: "old-chatgpt",
    });

    let result: unknown;
    await act(async () => {
      result = await deviceAuthMocks.onCompleted?.({ credentialId: "new-chatgpt" });
    });
    expect(result).toEqual({ success: true });
    expect(calls).toEqual(["test", "setDefault new-chatgpt", "revoke old-chatgpt"]);
    expect(showStatus).toHaveBeenLastCalledWith(
      "Connection replaced. Agents pinned to the old one now use the default.",
      "success",
      4500,
    );
  });

  it("leaves the default alone when the replaced sign-in was not it", async () => {
    isDefault.mockReturnValue(false);
    await mount();
    await signInAgain();
    await act(async () => {
      await deviceAuthMocks.onCompleted?.({ credentialId: "new-chatgpt" });
    });
    // Not the plain connect's "make it the default" either.
    expect(calls).toEqual(["test", "revoke old-chatgpt"]);
  });

  it("retires nothing when the new sign-in fails its test", async () => {
    controllerMocks.test.mockImplementation(async () => {
      calls.push("test");
      return { success: true, ok: false, output: "bad login" };
    });
    await mount();
    await signInAgain();
    let result: { warning?: string } | undefined;
    await act(async () => {
      result = await deviceAuthMocks.onCompleted?.({ credentialId: "new-chatgpt" });
    });
    expect(result?.warning).toContain("couldn't be verified");
    expect(calls).toEqual(["test"]);
  });

  it("a plain ChatGPT connect replaces nothing", async () => {
    await mount();
    await act(async () => captured?.openConnectModalAtStep("codex"));
    await act(async () => captured?.connectModalProps.onBeginDeviceAuth("codex"));
    expect(deviceAuthMocks.begin).toHaveBeenLastCalledWith({ provider: "codex", replacesCredentialId: null });
    await act(async () => {
      await deviceAuthMocks.onCompleted?.({ credentialId: "new-chatgpt" });
    });
    expect(calls).toEqual(["test", "setDefault new-chatgpt"]);
  });

  it("replaces with an uploaded auth.json the same way, named after the old one", async () => {
    await mount();
    await signInAgain({ id: "old-chatgpt", label: "Work plan", savedLabel: "Work plan" });
    await upload();
    expect(controllerMocks.createCodex).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Work plan", makeDefault: false }),
    );
    expect(calls).toEqual(["create", "test", "setDefault new-credential", "revoke old-chatgpt"]);

    // A plain upload is named for its path and retires nothing.
    calls = [];
    await act(async () => captured?.openConnectModalAtStep("codex"));
    await upload();
    expect(controllerMocks.createCodex).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ makeDefault: false }),
    );
    expect(controllerMocks.createCodex.mock.lastCall?.[0]).toMatchObject({ label: "Browser upload" });
    expect(calls).toEqual(["create"]);
  });

  it("removes an uploaded replacement that fails its test and keeps the old one", async () => {
    controllerMocks.test.mockImplementation(async () => {
      calls.push("test");
      return { success: true, ok: false, output: "token expired" };
    });
    await mount();
    await signInAgain();
    await upload();
    expect(calls).toEqual(["create", "test", "revoke new-credential"]);
    expect(showStatus).toHaveBeenLastCalledWith(
      "The new login couldn't be verified, so the old one stays: token expired",
      "error",
      7000,
    );
  });

  it("replaces with Desktop's local Codex login the same way", async () => {
    desktopMocks.available = true;
    await mount();
    await signInAgain();
    await act(async () => {
      await captured?.connectModalProps.onConnectCodex();
    });
    expect(desktopMocks.connect).toHaveBeenCalledWith({ label: "ChatGPT", makeDefault: false });
    expect(calls).toEqual(["create", "test", "setDefault new-credential", "revoke old-chatgpt"]);
  });

  it("never inherits a saved name the controller would refuse", async () => {
    // A name saved before the rules, with an email address in it.
    await mount();
    await signInAgain({ id: "old-chatgpt", label: "ann@example.com", savedLabel: "ann@example.com" });
    await upload();
    expect(controllerMocks.createCodex.mock.lastCall?.[0]).toMatchObject({ label: "Browser upload" });

    await act(async () => {
      captured?.openConnectModalToReplace(
        { id: "old-key", label: "Old key", savedLabel: "x".repeat(61) },
        "deepseek",
      );
      captured?.connectModalProps.onDeepseekApiKeyDraftChange("sk-new-key");
    });
    await act(async () => {
      await captured?.connectModalProps.onConnectApiKey("deepseek");
    });
    expect(controllerMocks.createCodex.mock.lastCall?.[0]).toMatchObject({ label: "DeepSeek" });
  });

  it("shows the rule instead of sending a typed name the controller would refuse", async () => {
    desktopMocks.available = true;
    await mount();
    await act(async () => {
      captured?.openConnectModalAtStep("codex");
      captured?.connectModalProps.onLabelDraftChange("Codex for ann@example.com");
    });
    await act(async () => {
      await captured?.connectModalProps.onConnectCodex();
    });
    // Desktop's import accepts 120 characters and answers any refusal with
    // a bare failure, so the name is checked before it is asked.
    expect(desktopMocks.connect).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith(
      "Leave the email address out of the name. Teammates see it on this connection's agent.",
      "error",
      5000,
    );

    await act(async () => captured?.connectModalProps.onLabelDraftChange("x".repeat(61)));
    await act(async () => {
      await captured?.connectModalProps.onConnectCodex();
    });
    expect(desktopMocks.connect).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith("Use a name of 1 to 60 characters on one line.", "error", 5000);

    await act(async () => {
      captured?.openConnectModalAtStep("deepseek");
      captured?.connectModalProps.onDeepseekApiKeyDraftChange("sk-new-key");
      captured?.connectModalProps.onDeepseekLabelDraftChange("ann@example.com");
    });
    let connected = true;
    await act(async () => {
      connected = (await captured?.connectModalProps.onConnectApiKey("deepseek")) ?? true;
    });
    expect(connected).toBe(false);
    expect(controllerMocks.createCodex).not.toHaveBeenCalled();
  });

  it("names an API-key replacement after the replaced connection unless the person types a name", async () => {
    isDefault.mockReturnValue(false);
    await mount();
    const replaceDeepseekKey = async (savedLabel: string | null, typedLabel = "") => {
      await act(async () => {
        captured?.openConnectModalToReplace(
          { id: "old-credential", label: savedLabel ?? "Credential old-cred", savedLabel },
          "deepseek",
        );
        captured?.connectModalProps.onDeepseekApiKeyDraftChange("sk-new-key");
        captured?.connectModalProps.onDeepseekLabelDraftChange(typedLabel);
      });
      await act(async () => {
        await captured?.connectModalProps.onConnectApiKey("deepseek");
      });
      return controllerMocks.createCodex.mock.lastCall?.[0] as { label?: string } | undefined;
    };
    expect((await replaceDeepseekKey("Team key"))?.label).toBe("Team key");
    expect(controllerMocks.revoke).toHaveBeenLastCalledWith("old-credential");
    expect((await replaceDeepseekKey("Team key", "  Night key "))?.label).toBe("Night key");
    // A connection saved without a name has none to keep.
    expect((await replaceDeepseekKey(null))?.label).toBe("DeepSeek");
  });
});
