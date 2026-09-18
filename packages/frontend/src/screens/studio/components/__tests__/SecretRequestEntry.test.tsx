// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecretRequestEntry,
  __resetSavedSecretNameRegistry,
} from "../ChatCredentialRequestEntries";
import type { ChatMessage } from "../../types";

// The card is the only way a value gets in, so these tests hold the shape of
// that one way: the value is named once, the product name comes from the
// connector registry rather than model prose, and every state that cannot take
// a value (read only, no space, already answered) closes the field rather than
// offering a way round it.

const mocks = vi.hoisted(() => ({
  activeMessages: [] as ChatMessage[],
  conversations: [] as Array<{ localId: string; messages: ChatMessage[] }>,
  onSubmit: vi.fn(),
  openPanelTab: vi.fn(),
  requestUrlPush: vi.fn(),
  showStatus: vi.fn(),
  setPendingPrefill: vi.fn(),
  listSecrets: vi.fn(),
  createSecret: vi.fn(),
  updateSecret: vi.fn(),
  canWriteProject: true as boolean | null,
}));

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ appendMessages: vi.fn(), conversations: mocks.conversations }),
}));

vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({
    activeConversationId: "conversation-active",
    messages: mocks.activeMessages,
    onRecordMessage: vi.fn(),
    onSubmit: mocks.onSubmit,
  }),
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

vi.mock("../../../../projects/ProjectAccessProvider", () => ({
  useOptionalProjectAccess: () =>
    mocks.canWriteProject === null ? null : { canWriteProject: mocks.canWriteProject },
}));

vi.mock("../secretManagerDeepLink", () => ({
  setPendingProjectSecretPrefill: mocks.setPendingPrefill,
}));

vi.mock("../device-auth/useDeviceAuthFlow", () => ({
  useDeviceAuthFlow: () => ({
    session: null,
    error: null,
    busy: false,
    begin: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    integrations: { listForProject: vi.fn(), upsert: vi.fn() },
    projects: { importGithub: vi.fn() },
    secrets: {
      listForProject: mocks.listSecrets,
      createForProject: mocks.createSecret,
      updateForProject: mocks.updateSecret,
    },
  },
}));

// What the runtime puts in the message metadata, with no name for the value.
const RUNTIME_REPLY = "I saved the value. Ready to continue.";
// What the card actually sends, in the provider's own words for the value.
const SUGGESTED_REPLY = "I saved the Installation access token. Ready to continue.";

function secretRequest(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "secret-request-1",
    role: "assistant",
    content: "Notion internal connection token.",
    timestamp: 1_700_000_000_000,
    messageType: "secret_request",
    metadata: {
      messageType: "secret_request",
      ui: { suggestedReply: RUNTIME_REPLY },
      details: { name: "NOTION_API_KEY", description: "Notion internal connection token." },
    },
    ...overrides,
  };
}

function details(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "NOTION_API_KEY", description: "Notion internal connection token.", ...overrides };
}

describe("SecretRequestEntry", () => {
  let container: HTMLDivElement;
  let root: Root;

  const text = () => container.textContent ?? "";
  const query = <T extends Element>(selector: string) => container.querySelector<T>(selector);
  const byTestId = <T extends Element>(id: string) => query<T>(`[data-testid="${id}"]`);

  const renderEntry = async (
    message: ChatMessage,
    detailRecord: Record<string, unknown> | null,
    projectId: string | null = "project-1",
  ) => {
    await act(async () => {
      root.render(
        <SecretRequestEntry message={message} projectId={projectId} details={detailRecord} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.activeMessages.splice(0);
    mocks.conversations.splice(0);
    mocks.onSubmit.mockReset().mockResolvedValue(undefined);
    mocks.openPanelTab.mockReset();
    mocks.requestUrlPush.mockReset();
    mocks.showStatus.mockReset();
    mocks.setPendingPrefill.mockReset();
    mocks.listSecrets.mockReset().mockResolvedValue({ success: true, secrets: [] });
    mocks.createSecret.mockReset().mockResolvedValue({ success: true });
    mocks.updateSecret.mockReset().mockResolvedValue({ success: true });
    mocks.canWriteProject = true;
    // Saves are broadcast between the cards of one page load, so each test
    // starts from a page that has saved nothing.
    __resetSavedSecretNameRegistry();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("names the value the way Notion does and prints the variable exactly once", async () => {
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details());

    expect(text()).toContain("Notion Installation access token");
    expect(text()).toContain(
      "Instafy can search and read the Notion pages you share with it, and add notes to them after you confirm each one.",
    );
    expect(text()).toContain("Saved in this space’s Secrets, never in the chat.");
    // The variable is what the agent and the Secrets panel need. The person
    // pasting the value never reads it, in any state.
    expect(text()).not.toContain("NOTION_API_KEY");
    // The model's own wording for the token is replaced by the provider's.
    expect(text()).not.toContain("internal connection token");
    expect(text()).not.toContain("SECRET REQUIRED");
    expect(text()).not.toContain("Add the secret in Secrets");

    const input = byTestId<HTMLInputElement>("secret-request-value-NOTION_API_KEY");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
    expect(input?.getAttribute("aria-label")).toBe("Installation access token value");
    expect(input?.className).toContain("[-webkit-text-security:disc]");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(input?.getAttribute("data-1p-ignore")).toBe("true");

    expect(byTestId("secret-request-save")?.textContent).toBe("Save and continue");
    expect(byTestId("secret-request-open")?.textContent).toBe("Manage secrets");
    expect(byTestId("secret-request-card")?.getAttribute("data-message-type")).toBe("secret_request");
  });

  it("saves the pasted value and continues the run on one press", async () => {
    const request = secretRequest();
    // The card is rendered from a run-thread preview, where the active
    // conversation is not the one holding the request.
    mocks.conversations.push({ localId: "conversation-thread", messages: [request] });
    await renderEntry(request, details());

    const input = byTestId<HTMLInputElement>("secret-request-value-NOTION_API_KEY")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "ntn_example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      byTestId<HTMLButtonElement>("secret-request-save")?.click();
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });

    expect(mocks.createSecret).toHaveBeenCalledTimes(1);
    expect(mocks.createSecret.mock.calls[0][0]).toBe("project-1");
    expect(mocks.createSecret.mock.calls[0][1]).toMatchObject({
      name: "NOTION_API_KEY",
      value: "ntn_example",
    });
    // The retry goes to the conversation holding the request, never to whatever
    // chat happens to be active, and it names the variable and nothing else.
    expect(mocks.onSubmit).toHaveBeenCalledWith("conversation-thread", SUGGESTED_REPLY);
    expect(text()).not.toContain("ntn_example");
  });

  it("only saves while another secret in the same conversation is still missing", async () => {
    const request = secretRequest();
    const second = secretRequest({
      id: "secret-request-2",
      metadata: {
        messageType: "secret_request",
        details: { name: "OTHER_TOKEN" },
      },
    });
    mocks.activeMessages.push(request, second);
    await renderEntry(request, details());

    expect(byTestId("secret-request-save")?.textContent).toBe("Save");
    expect(byTestId("secret-request-continue")).toBeNull();
  });

  it("lets the last of two secrets continue the run once both are saved", async () => {
    // Each card reads the project's stored names once, at mount. Before saves
    // were broadcast, saving both left each card still believing the other was
    // outstanding, so neither offered Continue and the only way on was a page
    // reload that nothing told the person to do.
    const first = secretRequest();
    const second = secretRequest({
      id: "secret-request-2",
      metadata: {
        messageType: "secret_request",
        details: { name: "OTHER_TOKEN" },
        ui: { suggestedReply: RUNTIME_REPLY },
      },
    });
    mocks.activeMessages.push(first, second);
    await act(async () => {
      root.render(
        <>
          <SecretRequestEntry message={first} projectId="project-1" details={details()} />
          <SecretRequestEntry message={second} projectId="project-1" details={{ name: "OTHER_TOKEN" }} />
        </>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const fill = async (testId: string, value: string) => {
      const input = byTestId<HTMLInputElement>(testId)!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const save = async (index: number) => {
      await act(async () => {
        container.querySelectorAll<HTMLButtonElement>('[data-testid="secret-request-save"]')[index]?.click();
        for (let step = 0; step < 12; step += 1) {
          await Promise.resolve();
        }
      });
    };

    // Neither card offers to continue while the other value is missing.
    const saveLabels = () =>
      [...container.querySelectorAll('[data-testid="secret-request-save"]')].map(
        (node) => node.textContent,
      );
    expect(saveLabels()).toEqual(["Save", "Save"]);

    await fill("secret-request-value-NOTION_API_KEY", "ntn_example");
    await save(0);
    expect(mocks.onSubmit).not.toHaveBeenCalled();

    await fill("secret-request-value-OTHER_TOKEN", "other_example");
    await save(0);

    expect(mocks.createSecret).toHaveBeenCalledTimes(2);
    expect(mocks.onSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.onSubmit.mock.calls[0][1]).toBe(RUNTIME_REPLY);
    // And the run resumes once: the sibling card does not go on offering it.
    expect(byTestId("secret-request-continue")).toBeNull();
  });

  it("reports a value that is already stored instead of demanding it again", async () => {
    mocks.listSecrets.mockResolvedValue({
      success: true,
      secrets: [{ id: "secret-1", name: "notion_api_key" }],
    });
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details());

    expect(byTestId("secret-request-saved")).not.toBeNull();
    // One fact, once, in one verb. The glyph carries the state; there is no
    // second Badge saying the same word.
    expect(text()).toContain("Saved in this space’s Secrets.");
    expect(text()).not.toContain("NOTION_API_KEY");
    expect(text().match(/Saved/g)).toHaveLength(1);
    expect(byTestId("secret-request-value-NOTION_API_KEY")).toBeNull();
    expect(byTestId("secret-request-save")).toBeNull();
    expect(byTestId("secret-request-continue")?.textContent).toBe("Continue setup");
    expect(byTestId("secret-request-open")).not.toBeNull();

    // The commonest reason a value is asked for twice is that the stored one is
    // wrong, so the card keeps a way back into its own field.
    await act(async () => {
      byTestId<HTMLElement>("secret-request-replace")!.click();
    });
    expect(byTestId("secret-request-value-NOTION_API_KEY")).not.toBeNull();
  });

  it("falls open to the unsaved state when the secrets list cannot be read", async () => {
    mocks.listSecrets.mockRejectedValue(new Error("offline"));
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details());

    expect(byTestId("secret-request-value-NOTION_API_KEY")).not.toBeNull();
    expect(byTestId("secret-request-saved")).toBeNull();
  });

  it("closes the field for a read-only member and does not prefill a create modal", async () => {
    mocks.canWriteProject = false;
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details());

    expect(byTestId("secret-request-readonly")?.textContent).toBe(
      "This space is read-only for you. An admin can add this value.",
    );
    expect(byTestId("secret-request-value-NOTION_API_KEY")).toBeNull();
    expect(byTestId("secret-request-save")).toBeNull();
    expect(text()).toContain("Read-only");

    await act(async () => {
      byTestId<HTMLButtonElement>("secret-request-open")?.click();
    });
    expect(mocks.setPendingPrefill).not.toHaveBeenCalled();
    expect(mocks.openPanelTab).toHaveBeenCalledWith("secrets", { activate: true });
  });

  it("disables the field and the actions with no space open", async () => {
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details(), null);

    // The safety sentence stays: this is the state where a person is most
    // likely to be improvising.
    expect(text()).toContain("Saved in this space’s Secrets, never in the chat.");
    expect(text()).toContain("Open a space to save this value.");
    expect(byTestId<HTMLInputElement>("secret-request-value-NOTION_API_KEY")?.disabled).toBe(true);
    expect(byTestId("secret-request-save")?.getAttribute("data-disabled")).not.toBeNull();
    expect(byTestId("secret-request-open")?.getAttribute("data-disabled")).not.toBeNull();
  });

  it("goes quiet once the run has been asked to continue", async () => {
    const request = secretRequest();
    mocks.activeMessages.push(request, {
      id: "user-reply",
      role: "user",
      content: SUGGESTED_REPLY,
      timestamp: 1_700_000_001_000,
    } as ChatMessage);
    await renderEntry(request, details());

    // Says what happened and who is acting, rather than "Asked to continue".
    expect(text()).toContain("Sent. The setup continues below.");
    expect(byTestId("secret-request-value-NOTION_API_KEY")).toBeNull();
    expect(byTestId("secret-request-save")).toBeNull();
    expect(byTestId("secret-request-continue")).toBeNull();
  });

  it("says what is missing when the request carries no name", async () => {
    const request = secretRequest({ metadata: { messageType: "secret_request", details: {} } });
    mocks.activeMessages.push(request);
    await renderEntry(request, {});

    expect(text()).toContain("Something is missing from this request");
    expect(text()).toContain("The assistant asked for a value but did not say which one.");
    expect(container.querySelector("input")).toBeNull();
    expect(byTestId("secret-request-save")).toBeNull();
    expect(byTestId("secret-request-open")).not.toBeNull();
  });

  it("titles an unknown secret from the model's first sentence and keeps its prose", async () => {
    const request = secretRequest({
      content: "Cloudflare API token used for deployments.",
      metadata: {
        messageType: "secret_request",
        details: {
          name: "CLOUDFLARE_API_TOKEN",
          description: "Cloudflare API token used for deployments.",
        },
      },
    });
    mocks.activeMessages.push(request);
    await renderEntry(request, {
      name: "CLOUDFLARE_API_TOKEN",
      description: "Cloudflare API token used for deployments.",
    });

    expect(text()).toContain("Cloudflare API token used for deployments.");
    expect(text()).toContain("Saved in this space’s Secrets, never in the chat.");
    expect(text()).not.toContain("CLOUDFLARE_API_TOKEN in this space");
    expect(byTestId<HTMLInputElement>("secret-request-value-CLOUDFLARE_API_TOKEN")?.getAttribute(
      "aria-label",
    )).toBe("CLOUDFLARE_API_TOKEN value");
  });

  it("names the agents allowed to use the value in the caption", async () => {
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details({ agentHandles: ["octo", "ledger"] }));

    expect(text()).toContain("Only @octo and @ledger can use it.");
    expect(text()).not.toContain("@octo\n");
  });

  it("shows a failed save inline as well as in the toast", async () => {
    mocks.createSecret.mockResolvedValue({ success: false, error: "Saving is switched off here." });
    const request = secretRequest();
    mocks.activeMessages.push(request);
    await renderEntry(request, details());

    const input = byTestId<HTMLInputElement>("secret-request-value-NOTION_API_KEY")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "ntn_example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      byTestId<HTMLButtonElement>("secret-request-save")?.click();
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });

    expect(byTestId("secret-request-error")?.textContent).toBe("Saving is switched off here.");
    expect(mocks.showStatus).toHaveBeenCalled();
    // The value stays put so the person does not have to fetch it twice.
    expect(byTestId<HTMLInputElement>("secret-request-value-NOTION_API_KEY")?.value).toBe(
      "ntn_example",
    );
    expect(mocks.onSubmit).not.toHaveBeenCalled();
  });
});
