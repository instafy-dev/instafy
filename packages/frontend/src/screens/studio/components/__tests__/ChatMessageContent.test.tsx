// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageContent } from "../ChatMessageContent";
import { AssistantMessageEntry, ChatRuntimeActivityContext, UserMessageBubble } from "../ChatMessageEntries";
import type { ChatMessage } from "../../types";

const { getWorkspaceFileRawUrl, readWorkspaceFile } = vi.hoisted(() => ({
  getWorkspaceFileRawUrl: vi.fn(),
  readWorkspaceFile: vi.fn(),
}));
const openConversationTab = vi.fn();
const openPanelTab = vi.fn();
const requestUrlPush = vi.fn();
const resolveConversationByController = vi.fn();
const showStatusMock = vi.fn();

vi.mock("../../../../sdk/instafy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../sdk/instafy")>();
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      workspace: {
        ...actual.controllerClient.workspace,
        files: {
          ...actual.controllerClient.workspace.files,
          getRawUrl: getWorkspaceFileRawUrl,
          read: readWorkspaceFile,
        },
      },
    },
  };
});

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => {
    throw new Error("Message bodies must not subscribe to composer draft state.");
  },
}));

vi.mock("../../../../conversations/ConversationMessageMetadata", () => ({
  useConversationMessageMetadata: () => ({
    resolveConversationLocalId: (id: string) => resolveConversationByController(id)?.localId ?? null,
    extraAgentHandles: ["custom-agent"],
  }),
}));

vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => {
    throw new Error("Message bodies must not mount conversation history or dispatch effects.");
  },
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openConversationTab,
    openPanelTab,
    requestUrlPush,
  }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({
    showStatus: showStatusMock,
  }),
}));

describe("ChatMessageContent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    openConversationTab.mockReset();
    openPanelTab.mockReset();
    requestUrlPush.mockReset();
    resolveConversationByController.mockReset();
    showStatusMock.mockReset();
    getWorkspaceFileRawUrl.mockReset();
    readWorkspaceFile.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    const runtimeWindow = window as typeof window & { __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown };
    delete runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  it("renders configured and supplied agent mentions without mounting a conversation controller", async () => {
    await act(async () => {
      root.render(<MessageContent content="Ask @custom-agent and @supplied-agent with @octo." mentionableAgentHandles={["supplied-agent"]} />);
    });

    expect(Array.from(container.querySelectorAll('[data-testid="chat-agent-mention"]')).map((node) => node.textContent))
      .toEqual(["@custom-agent", "@supplied-agent", "@octo"]);
  });

  it("renders inline conversation, thread, and message references and opens the containing conversation", async () => {
    resolveConversationByController.mockImplementation((controllerId: string) => {
      if (controllerId === "conversation-controller-789") {
        return { localId: "conversation-local-789" };
      }
      if (controllerId === "thread-controller-123") {
        return { localId: "thread-local-123" };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <MessageContent content="Context from [[conversation:conversation-controller-789|Prior audit]]. Tracked in [[thread:thread-controller-123|@octo]]. See [[message:thread-controller-123/message-456|latest trace]]." />,
      );
    });

    const refs = Array.from(container.querySelectorAll('[data-testid="chat-message-inline-reference"]'));
    expect(refs).toHaveLength(3);
    expect(refs.map((entry) => entry.textContent?.trim())).toEqual(["Prior audit", "@octo", "latest trace"]);
    expect(refs.map((entry) => entry.getAttribute("data-inline-ref-kind"))).toEqual([
      "conversation",
      "thread",
      "message",
    ]);
    expect(refs[0]?.getAttribute("title")).toBe(
      "Open referenced conversation: Prior audit\nStable conversation id: conversation-controller-789",
    );
    expect(refs[1]?.getAttribute("title")).toBe(
      "Open referenced thread: @octo\nStable thread id: thread-controller-123",
    );
    expect(refs[2]?.getAttribute("aria-label")).toBe("Open referenced message: latest trace");
    expect(refs[2]?.getAttribute("title")).toBe(
      "Open referenced message: latest trace\nStable message id: thread-controller-123/message-456",
    );

    (refs[0] as HTMLButtonElement).click();
    (refs[1] as HTMLButtonElement).click();
    (refs[2] as HTMLButtonElement).click();

    expect(requestUrlPush).toHaveBeenCalledTimes(3);
    expect(openConversationTab).toHaveBeenCalledTimes(3);
    expect(openConversationTab).toHaveBeenNthCalledWith(1, "conversation-local-789");
    expect(openConversationTab).toHaveBeenNthCalledWith(2, "thread-local-123");
    expect(openConversationTab).toHaveBeenNthCalledWith(3, "thread-local-123");
    expect(showStatusMock).not.toHaveBeenCalled();
  });

  it("renders explicit recovered workstream lines as a compact clickable workstream rail", async () => {
    resolveConversationByController.mockImplementation((controllerId: string) => {
      if (controllerId === "conversation-controller-789") {
        return { localId: "conversation-local-789" };
      }
      if (controllerId === "thread-controller-123") {
        return { localId: "thread-local-123" };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <MessageContent
          content={
            "I found the existing lanes that now need coordination.\nWorkstreams: [[conversation:conversation-controller-789|frontend lane]] · [[thread:thread-controller-123|@runtime lane]]\nI will answer from those flows first."
          }
        />,
      );
    });

    const rail = container.querySelector('[data-testid="team-flow-inline-status"]');
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute("aria-label")).toBe("Workstream references: 2 lanes");
    expect(container.querySelector('[data-testid="team-flow-team-chip"]')?.textContent?.trim()).toBe("Workstreams");
    expect(container.textContent).not.toContain("Workstreams:");
    expect(container.textContent).toContain("frontend lane");
    expect(container.textContent).toContain("@runtime lane");

    const refs = Array.from(rail?.querySelectorAll('[data-testid="chat-message-inline-reference"]') ?? []);
    expect(refs).toHaveLength(2);
    expect(refs.map((entry) => entry.textContent?.trim())).toEqual(["frontend lane", "@runtime lane"]);
    expect(refs[0]?.className).not.toContain("mx-0.5");

    (refs[0] as HTMLButtonElement).click();
    (refs[1] as HTMLButtonElement).click();

    expect(requestUrlPush).toHaveBeenCalledTimes(2);
    expect(openConversationTab).toHaveBeenNthCalledWith(1, "conversation-local-789");
    expect(openConversationTab).toHaveBeenNthCalledWith(2, "thread-local-123");
  });

  it("renders markdown-style quotes as compact quote blocks", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={"> Inspect `bigint.ts:15` before editing.\n> Keep the answer short.\n\nSummarize"}
          projectId="project-1"
        />,
      );
    });

    const quote = container.querySelector("blockquote");
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toContain("Inspect");
    expect(quote?.textContent).toContain("bigint.ts:15");
    expect(quote?.textContent).toContain("Keep the answer short.");
    expect(quote?.textContent).not.toContain("> Inspect");
    expect(container.textContent).toContain("Summarize");
    expect(quote?.querySelector("svg")).not.toBeNull();
    expect(quote?.querySelector('[data-testid="chat-message-quote-source-reference"]')).toBeNull();

    const fileChip = quote?.querySelector('[data-testid="chat-message-file-reference-inline"]');
    expect(fileChip?.textContent?.trim()).toBe("bigint.ts:15");
  });

  it("opens the source message from selection reply quote metadata", async () => {
    resolveConversationByController.mockImplementation((controllerId: string) => {
      if (controllerId === "conversation-controller-123") {
        return { localId: "conversation-local-123" };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <MessageContent
          content={"> Selected source text.\n\nExplain more"}
          metadata={{
            replyContext: {
              kind: "message_selection",
              conversationId: "conversation-controller-123",
              messageId: "message-456",
              action: "explain_more",
              selectedText: "Selected source text.",
              textStart: 10,
              textEnd: 31,
              selectionHash: "abc123",
              sourceContentHash: "def456",
            },
          }}
        />,
      );
    });

    const sourceButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-message-quote-source-reference"]',
    );
    expect(sourceButton).not.toBeNull();
    expect(sourceButton?.getAttribute("data-conversation-id")).toBe("conversation-controller-123");
    expect(sourceButton?.getAttribute("data-message-id")).toBe("message-456");
    expect(sourceButton?.getAttribute("aria-label")).toBe("Open quoted source");

    sourceButton?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openConversationTab).toHaveBeenCalledWith("conversation-local-123");
    expect(showStatusMock).not.toHaveBeenCalled();
  });

  it("opens the source message when selection metadata is nested in prompt metadata", async () => {
    resolveConversationByController.mockImplementation((controllerId: string) => {
      if (controllerId === "conversation-controller-456") {
        return { localId: "conversation-local-456" };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <MessageContent
          content={"> Selected source text.\n\nSummarize"}
          metadata={{
            prompt_metadata: {
              reply_context: {
                kind: "message_selection",
                conversation_id: "conversation-controller-456",
                message_id: "message-789",
                action: "summarize",
                selected_text: "Selected source text.",
              },
            },
          }}
        />,
      );
    });

    const sourceButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-message-quote-source-reference"]',
    );
    expect(sourceButton).not.toBeNull();
    expect(sourceButton?.getAttribute("data-conversation-id")).toBe("conversation-controller-456");
    expect(sourceButton?.getAttribute("data-message-id")).toBe("message-789");

    sourceButton?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openConversationTab).toHaveBeenCalledWith("conversation-local-456");
    expect(showStatusMock).not.toHaveBeenCalled();
  });

  it("keeps hand-typed quote blocks decorative when no source metadata exists", async () => {
    await act(async () => {
      root.render(<MessageContent content={"> ---\n\nManual quote"} />);
    });

    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-message-quote-source-reference"]')).toBeNull();
  });

  it("keeps short single-agent answers free of team coordination chrome", async () => {
    await act(async () => {
      root.render(<MessageContent content="2" />);
    });

    expect(container.textContent?.trim()).toBe("2");
    expect(container.querySelector('[data-testid="team-flow-inline-status"]')).toBeNull();
    expect(container.querySelector('[data-testid="team-flow-team-chip"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-message-inline-reference"]')).toBeNull();
  });

  it("renders hard-wrapped source text as one paragraph instead of one <p> per source line (#210)", async () => {
    const hardWrapped = [
      "You are an autonomous engineer running inside the Instafy agent",
      "stack. Each run of this runbook is ONE iteration: handle at most",
      "one bug, land it, and stop. Small, safe, reviewable changes",
      "are fine. Prefer doing less, correctly, over doing more.",
    ].join("\n");

    await act(async () => {
      root.render(<MessageContent content={hardWrapped} />);
    });

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.className).not.toContain("mt-4");
    expect(paragraphs[0]?.className).toContain("whitespace-pre-wrap");
    // whitespace-pre-wrap renders the embedded "\n" as a line break while
    // keeping it a single <p> — textContent preserves the raw newlines.
    expect(paragraphs[0]?.textContent).toBe(hardWrapped);
  });

  it("still starts a new <p> only at a blank line, and keeps a chat author's newline as a break", async () => {
    await act(async () => {
      root.render(<MessageContent content={"para one line a\npara one line b\n\npara two"} />);
    });

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("para one line a\npara one line b");
    expect(paragraphs[0]?.className).not.toContain("mt-4");
    expect(paragraphs[1]?.textContent).toBe("para two");
    expect(paragraphs[1]?.className).toContain("mt-4");
  });

  it("offers AI settings from upstream quota failures", async () => {
    const quotaError = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, endpoint=api.openai.com/v1/responses): backend responded with 429 Too Many Requests: {
      "error": {
        "message": "You exceeded your current quota.",
        "type": "insufficient_quota",
        "code": "insufficient_quota"
      },
      "status": 429
    }`;

    await act(async () => {
      root.render(<MessageContent content={quotaError} />);
    });

    expect(container.textContent).toContain("Upstream 429 rejected the AI request (insufficient_quota).");
    expect(container.textContent).toContain("separate from Instafy workspace credits");
    const action = container.querySelector<HTMLButtonElement>('[data-testid="chat-message-proxy-error-action"]');
    expect(action?.textContent).toBe("Manage AI");

    action?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("ai", { activate: true });
  });

  it("offers reconnect action from summarized credential failures", async () => {
    await act(async () => {
      root.render(
        <MessageContent content="ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message." />,
      );
    });

    expect(container.textContent).toContain("ChatGPT login needs reconnecting.");
    expect(container.textContent).toContain("The saved AI login is stale");
    const action = container.querySelector<HTMLButtonElement>('[data-testid="chat-message-proxy-error-action"]');
    expect(action?.textContent).toBe("Open AI settings");

    action?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("ai", { activate: true });
  });

  it("keeps malformed reference tags as plain text and preserves mixed token parsing", async () => {
    resolveConversationByController.mockImplementation((controllerId: string) => {
      if (controllerId === "thread-controller-123") {
        return { localId: "thread-local-123" };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <MessageContent
          content={"Malformed [[thread:|broken]] but valid [[thread:thread-controller-123]] plus @octo and docs/README.md:12"}
          mentionableAgentHandles={["octo"]}
        />,
      );
    });

    expect(container.textContent).toContain("Malformed [[thread:|broken]] but valid");
    const refs = Array.from(container.querySelectorAll('[data-testid="chat-message-inline-reference"]'));
    expect(refs).toHaveLength(1);
    expect(refs[0]?.textContent?.trim()).toBe("Referenced thread");
    expect(container.querySelector('[data-testid="chat-message-file-reference-inline"]')).not.toBeNull();
  });

  it("renders inline code without leaking markdown backticks", async () => {
    await act(async () => {
      root.render(<MessageContent content="Inspect `TODO.md` before running `pnpm test` or mentioning `@octo`." projectId="project-1" />);
    });

    expect(container.textContent).not.toContain("`");

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();
    expect(fileRef?.textContent?.trim()).toBe("TODO.md");
    expect(fileRef?.getAttribute("title")).toBe("TODO.md");
    expect(fileRef?.className).toContain("max-w-[14rem]");
    expect(fileRef?.className).toContain("min-w-0");
    expect(fileRef?.className).toContain("overflow-hidden");
    expect(fileRef?.className).not.toContain("my-0.5");
    expect(fileRef?.className).toContain("py-[0.08em]");
    expect(fileRef?.className).toContain("leading-[1.18]");
    expect(fileRef?.className).toContain("align-baseline");
    expect(fileRef?.className).toContain("bg-primary-50/70");
    expect(fileRef?.className).toContain("text-primary-700");
    expect(fileRef?.className).toContain("ring-primary-200/80");
    expect(fileRef?.className).toContain("hover:bg-primary-100/80");
    expect(fileRef?.className).not.toContain("bg-slate-100");
    expect(fileRef?.querySelector("span")?.className).toContain("truncate");

    const codeRefs = Array.from(container.querySelectorAll('[data-testid="chat-message-inline-code"]'));
    expect(codeRefs.map((entry) => entry.textContent?.trim())).toEqual(["pnpm test", "@octo"]);
    codeRefs.forEach((entry) => {
      expect(entry.className).not.toContain("my-0.5");
      expect(entry.className).toContain("py-[0.04em]");
      expect(entry.className).toContain("leading-[1.18]");
      expect(entry.getAttribute("data-code-layout")).toBe("inline");
      expect(entry.className).toContain("align-baseline");
      expect(entry.className).toContain("bg-slate-950/[0.025]");
      expect(entry.className).not.toContain("shadow-");
      expect(entry.className).not.toContain("ring-");
      expect(entry.className).not.toContain("bg-slate-100");
      expect(entry.className).not.toContain("text-primary-700");
    });
    expect(container.querySelector('[data-testid="chat-message-inline-reference"]')).toBeNull();

    fileRef?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("code");
    expect((window as typeof window & { __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown }).__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toEqual({
      path: "TODO.md",
      projectId: "project-1",
      returnTarget: "assistant",
    });
  });

  it("contains a long inline command without adding punctuation to its copyable text", async () => {
    const command = 'node ./tools/check.mjs --workspace "./demo project" --filter "reader layout" --report ./artifacts/result.json';
    await act(async () => {
      root.render(<MessageContent content={`Run \`${command}\`, then read the result.`} />);
    });

    const code = container.querySelector('[data-testid="chat-message-inline-code"]');
    expect(code?.getAttribute("data-code-layout")).toBe("block");
    expect(code?.textContent).toBe(command);
    expect(code?.closest('[data-testid="chat-message-chip-glue"]')).toBeNull();
    expect(container.textContent).toBe(`Run ${command}, then read the result.`);
    // Keep valid phrasing content inside the original paragraph.
    expect(code?.parentElement?.getAttribute("data-testid")).toBe("chat-message-long-code");
    expect(code?.parentElement?.textContent).toBe(`${command},`);
    expect(code?.parentElement?.parentElement?.tagName).toBe("P");
    expect(container.querySelector("p pre, p div")).toBeNull();
  });

  it("preserves newlines and spaces in a multiline inline snippet", async () => {
    const snippet = 'echo "first"\n  echo "second"';
    await act(async () => {
      root.render(<MessageContent content={`Inspect \`${snippet}\`.`} />);
    });
    const code = container.querySelector('[data-testid="chat-message-inline-code"]');
    expect(code?.getAttribute("data-code-layout")).toBe("block");
    expect(code?.textContent).toBe(snippet);
    expect(container.textContent).toBe(`Inspect ${snippet}.`);
  });

  it("keeps headings and list structure when long snippets appear inside emphasis or a list", async () => {
    const snippet = "value_".repeat(15);
    await act(async () => {
      root.render(<MessageContent content={`**Check \`${snippet}\` first.**\n\n- Inspect \`${snippet}\`.\n- Continue.`} />);
    });
    expect(container.querySelectorAll("h1, h2, h3")).toHaveLength(0);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong code")?.textContent).toBe(snippet);
    expect(container.querySelector("li code")?.getAttribute("data-code-layout")).toBe("block");
    expect(container.querySelectorAll("pre")).toHaveLength(0);
  });

  it("renders a fenced code block after a paren-delimited ordered-list item", async () => {
    await act(async () => {
      root.render(
        <MessageContent content={"3) Command output:\n```text\nexample-user\nd3fdb3f\n```\n\nBOX OK"} />,
      );
    });

    const list = container.querySelector('[data-testid="chat-message-list"]');
    expect(list?.tagName).toBe("OL");
    expect(list?.getAttribute("start")).toBe("3");
    expect(list?.textContent?.trim()).toBe("Command output:");

    const codeBlock = container.querySelector('[data-testid="chat-message-code-block"]');
    expect(codeBlock?.tagName).toBe("PRE");
    expect(codeBlock?.getAttribute("data-code-language")).toBe("text");
    expect(codeBlock?.textContent).toBe("example-user\nd3fdb3f");

    expect(container.textContent).not.toContain("`");
    expect(container.textContent).toContain("BOX OK");
  });

  it("renders a fenced code block outside any list without regressions", async () => {
    await act(async () => {
      root.render(<MessageContent content={"Before\n```json\n{ \"ok\": true }\n```\nAfter"} />);
    });

    const codeBlock = container.querySelector('[data-testid="chat-message-code-block"]');
    expect(codeBlock?.getAttribute("data-code-language")).toBe("json");
    expect(codeBlock?.textContent).toBe('{ "ok": true }');
    expect(container.textContent).not.toContain("```");
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
  });

  it("renders strong markdown without leaking markers outside inline code", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={"**Findings**\nThe **codec-audit** lane found `bigint.ts:15`; keep `**literal**` as code."}
          projectId="project-1"
        />,
      );
    });

    const strongEntries = Array.from(container.querySelectorAll("strong"));
    expect(strongEntries.map((entry) => entry.textContent?.trim())).toEqual(["Findings", "codec-audit"]);
    expect(strongEntries[0]?.className).toContain("font-semibold");
    expect(container.textContent).not.toContain("**Findings**");
    expect(container.textContent).not.toContain("**codec-audit**");

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef?.textContent?.trim()).toBe("bigint.ts:15");

    const codeRefs = Array.from(container.querySelectorAll('[data-testid="chat-message-inline-code"]'));
    expect(codeRefs.map((entry) => entry.textContent?.trim())).toEqual(["**literal**"]);
  });

  it("writes out the host of an unapproved link, so a label cannot stand in for it", async () => {
    await act(async () => {
      root.render(
        <MessageContent content={"Read [the docs](https://example.com/docs) and keep `[literal](https://example.com/raw)` as code."} />,
      );
    });

    const links = Array.from(container.querySelectorAll('[data-testid="chat-message-link"]'));
    expect(links).toHaveLength(1);
    // A "clean labeled link" is the phishing shape: chat text arrives from a
    // model that reads packs fetched from arbitrary repositories, and a label
    // is whatever the pack felt like writing. The host goes beside it.
    expect(links[0]?.textContent?.trim()).toBe("the docs(example.com)");
    expect(links[0]?.getAttribute("data-link-known")).toBe("false");
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/docs");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("title")).toBe("https://example.com/docs");
    expect(container.textContent).not.toContain("[the docs]");
    expect(container.textContent).not.toContain("(https://example.com/docs)");

    const codeRefs = Array.from(container.querySelectorAll('[data-testid="chat-message-inline-code"]'));
    expect(codeRefs.map((entry) => entry.textContent?.trim())).toEqual(["[literal](https://example.com/raw)"]);
  });

  it("lets an approved host wear its mark instead of its address", async () => {
    await act(async () => {
      root.render(
        <MessageContent content={"Open [your connections](https://www.notion.so/developers/connections)."} />,
      );
    });

    const link = container.querySelector('[data-testid="chat-message-link"]');
    expect(link?.getAttribute("data-link-known")).toBe("true");
    expect(link?.getAttribute("data-link-host")).toBe("notion.so");
    // The mark says Notion, so the address does not have to.
    expect(link?.textContent?.trim()).toBe("your connections");
    expect(container.querySelector('[data-testid="chat-message-link-host"]')).toBeNull();
  });

  it("treats a look-alike host as the stranger it is", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={"Open [Notion](https://notion.so.evil.test/verify) and [Notion](https://evilnotion.so/verify)."}
        />,
      );
    });

    const links = Array.from(container.querySelectorAll('[data-testid="chat-message-link"]'));
    expect(links).toHaveLength(2);
    // Ending with the same letters is not the same host. Both wear no mark and
    // both say where they actually go.
    expect(links.map((entry) => entry.getAttribute("data-link-known"))).toEqual(["false", "false"]);
    expect(container.textContent).toContain("(notion.so.evil.test)");
    expect(container.textContent).toContain("(evilnotion.so)");
  });

  it("does not make an unparseable or non-web link pressable", async () => {
    await act(async () => {
      root.render(<MessageContent content={"Try [this](javascript:alert(1)) instead."} />);
    });

    expect(container.querySelector('[data-testid="chat-message-link"]')).toBeNull();
  });

  it("renders GitHub PR and issue URLs as compact chips while other URLs stay plain links", async () => {
    await act(async () => {
      root.render(
        <MessageContent content="Opened https://github.com/instafy-dev/instafy/pull/551. Tracked in https://github.com/instafy-dev/instafy/issues/173 and https://example.com/docs." />,
      );
    });

    const chips = Array.from(
      container.querySelectorAll('[data-testid="chat-message-github-reference"]'),
    ) as HTMLAnchorElement[];
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
      "instafy-dev/instafy#551",
      "instafy-dev/instafy#173",
    ]);
    expect(chips.map((chip) => chip.getAttribute("data-github-ref-kind"))).toEqual(["pull", "issue"]);
    expect(chips[0]?.getAttribute("href")).toBe("https://github.com/instafy-dev/instafy/pull/551");
    expect(chips[0]?.getAttribute("title")).toBe("https://github.com/instafy-dev/instafy/pull/551");
    expect(chips[0]?.getAttribute("target")).toBe("_blank");
    expect(chips[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(chips[0]?.querySelector('[data-testid="chat-message-github-reference-glyph"]')).not.toBeNull();
    // The chip elides the raw URL but keeps the trailing punctuation as prose.
    expect(container.textContent).not.toContain("https://github.com/instafy-dev/instafy/pull/551");
    expect(container.textContent).toContain("instafy-dev/instafy#551.");

    const links = Array.from(container.querySelectorAll('[data-testid="chat-message-link"]'));
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("renders simple markdown lists as compact semantic lists", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={"Summary:\n- Inspect `TODO.md`\n- Run checks\n\n1. First result\n2. Second result"}
          projectId="project-1"
        />,
      );
    });

    const lists = Array.from(container.querySelectorAll('[data-testid="chat-message-list"]'));
    expect(lists).toHaveLength(2);
    expect(lists[0]?.tagName).toBe("UL");
    expect(lists[1]?.tagName).toBe("OL");
    expect(lists[0]?.className).toContain("space-y-0.5");
    expect(lists[0]?.querySelectorAll("li")).toHaveLength(2);
    expect(lists[1]?.querySelectorAll("li")).toHaveLength(2);

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef?.textContent?.trim()).toBe("TODO.md");
    expect(fileRef?.getAttribute("title")).toBe("TODO.md");
  });

  it("renders bulleted sublists nested inside their ordered parent item", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={"1. First step\n   - detail a\n   - detail b\n2. Second step"}
          projectId="project-1"
        />,
      );
    });

    const list = container.querySelector('[data-testid="chat-message-list"]');
    expect(list?.tagName).toBe("OL");
    // Ordered markers carry sequence, so they read a shade darker than bullets.
    expect(list?.className).toContain("marker:text-slate-500");
    const topLevelItems = Array.from(list?.children ?? []);
    expect(topLevelItems).toHaveLength(2);

    const sublist = topLevelItems[0]?.querySelector('[data-testid="chat-message-sublist"]');
    expect(sublist?.tagName).toBe("UL");
    expect(sublist?.getAttribute("data-list-depth")).toBe("1");
    // Nested bullets step to circle and indent one fixed step under the item.
    expect(sublist?.className).toContain("[list-style-type:circle]");
    expect(sublist?.className).toContain("pl-5");
    // The sublist keeps the sibling half-step rhythm so the indent groups it.
    expect(sublist?.className).toContain("mt-0.5");
    expect(sublist?.className).not.toContain("mt-1");
    expect(Array.from(sublist?.querySelectorAll("li") ?? []).map((item) => item.textContent)).toEqual([
      "detail a",
      "detail b",
    ]);
    expect(topLevelItems[1]?.querySelector('[data-testid="chat-message-sublist"]')).toBeNull();
  });

  it("nests unindented bullets after an ordered item the way the real agent thread writes them", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={
            "1. Persistent-context skills starting with `autofix-`:\n- `autofix-bugfix`: land a fix\n- `autofix-triage`: sort reports\n2. Done."
          }
          projectId="project-1"
        />,
      );
    });

    const lists = Array.from(container.querySelectorAll('[data-testid="chat-message-list"]'));
    expect(lists).toHaveLength(1);
    expect(lists[0]?.tagName).toBe("OL");
    const topLevelItems = Array.from(lists[0]?.children ?? []);
    expect(topLevelItems).toHaveLength(2);
    const sublist = topLevelItems[0]?.querySelector('[data-testid="chat-message-sublist"]');
    expect(sublist?.tagName).toBe("UL");
    expect(sublist?.getAttribute("data-list-depth")).toBe("1");
    expect(sublist?.className).toContain("[list-style-type:circle]");
    expect(Array.from(sublist?.querySelectorAll("li") ?? []).map((item) => item.textContent)).toEqual([
      "autofix-bugfix: land a fix",
      "autofix-triage: sort reports",
    ]);
    expect(topLevelItems[1]?.textContent).toBe("Done.");
  });

  it("glues an inline chip to the punctuation that follows it so it cannot wrap alone", async () => {
    await act(async () => {
      root.render(
        <MessageContent
          content={"First bullet under `Identity, repos, ground rules` in `AGENTS.md`: keep it green with `pnpm test`."}
          projectId="project-1"
        />,
      );
    });

    const glued = Array.from(container.querySelectorAll('[data-testid="chat-message-chip-glue"]'));
    expect(glued).toHaveLength(2);
    expect(glued[0]?.className).toContain("whitespace-nowrap");
    expect(glued[1]?.className).toContain("max-w-full");
    expect(glued[1]?.className).toContain("whitespace-pre-wrap");
    // The workspace-file chip carries its trailing colon inside the no-break span.
    expect(glued[0]?.querySelector('[data-testid="chat-message-file-reference-inline"]')?.textContent?.trim()).toBe(
      "AGENTS.md",
    );
    expect(glued[0]?.textContent).toBe("AGENTS.md:");
    // The inline-code chip carries its trailing period the same way.
    expect(glued[1]?.querySelector('[data-testid="chat-message-inline-code"]')?.textContent).toBe("pnpm test");
    expect(glued[1]?.textContent).toBe("pnpm test.");
    // A chip followed by a space stays unwrapped, and the prose around it is intact.
    const inlineCode = Array.from(container.querySelectorAll('[data-testid="chat-message-inline-code"]'));
    expect(inlineCode.map((entry) => entry.textContent)).toEqual(["Identity, repos, ground rules", "pnpm test"]);
    expect(inlineCode[0]?.parentElement?.getAttribute("data-testid")).not.toBe("chat-message-chip-glue");
    expect(container.textContent).toBe(
      "First bullet under Identity, repos, ground rules in AGENTS.md: keep it green with pnpm test.",
    );
  });

  it("glues a conversation-reference and a GitHub-reference chip to their trailing punctuation too", async () => {
    resolveConversationByController.mockReturnValue(null);
    await act(async () => {
      root.render(
        <MessageContent
          content={
            "See [[thread:thread-controller-123|design pass]]: it landed. Tracked in https://github.com/instafy-dev/instafy/pull/551."
          }
        />,
      );
    });

    const glued = Array.from(container.querySelectorAll('[data-testid="chat-message-chip-glue"]'));
    expect(glued).toHaveLength(2);
    glued.forEach((entry) => {
      expect(entry.className).toContain("whitespace-nowrap");
    });
    // The conversation-reference chip carries its trailing colon inside the no-break span.
    expect(glued[0]?.querySelector('[data-testid="chat-message-inline-reference"]')?.textContent).toBe(
      "design pass",
    );
    expect(glued[0]?.textContent).toBe("design pass:");
    // The github-reference chip carries its trailing period the same way.
    expect(glued[1]?.querySelector('[data-testid="chat-message-github-reference"]')?.textContent?.trim()).toBe(
      "instafy-dev/instafy#551",
    );
    expect(glued[1]?.textContent).toBe("instafy-dev/instafy#551.");
  });

  it("keeps a fenced block inside a list item on the item's indent", async () => {
    await act(async () => {
      root.render(
        <MessageContent content={"1. Run the check:\n   ```sh\n   pnpm test\n   ```\n2. Ship it"} />,
      );
    });

    const codeBlock = container.querySelector('[data-testid="chat-message-code-block"]');
    expect(codeBlock?.getAttribute("data-in-list-item")).toBe("true");
    expect(codeBlock?.className).toContain("ml-5");
    expect(codeBlock?.textContent).toBe("pnpm test");
  });

  it("keeps long reference labels compact and reports refs that cannot be resolved", async () => {
    resolveConversationByController.mockReturnValue(null);
    const longLabel = "The very long linked agent thread title that should not stretch the chat bubble indefinitely";

    await act(async () => {
      root.render(<MessageContent content={`See [[thread:missing-controller-thread|${longLabel}]].`} />);
    });

    const ref = container.querySelector('[data-testid="chat-message-inline-reference"]') as HTMLButtonElement | null;
    expect(ref).not.toBeNull();
    expect(ref?.disabled).toBe(false);
    expect(ref?.getAttribute("title")).toBe(
      `Referenced thread is unavailable: ${longLabel}\nStable thread id: missing-controller-thread`,
    );
    expect(ref?.className).toContain("mx-0.5");
    expect(ref?.className).toContain("gap-1.5");
    expect(ref?.className).toContain("bg-primary-500/10");
    expect(ref?.className).toContain("cursor-pointer");
    expect(ref?.className).toContain("opacity-80");
    expect(ref?.className).toContain("focus:outline-none");
    expect(ref?.className).toContain("focus-visible:ring-2");
    expect(ref?.querySelector('[data-testid="chat-message-inline-reference-icon"]')).not.toBeNull();
    expect(ref?.querySelector("span")?.className).toContain("truncate");
    expect(ref?.querySelector("span")?.className).toContain("block");

    ref?.click();

    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openConversationTab).not.toHaveBeenCalled();
    expect(showStatusMock).toHaveBeenCalledWith(
      `That thread reference is not available here: ${longLabel}.`,
      "info",
      3500,
      { forceVisible: true },
    );
  });

  it("keeps long workspace file references from widening the chat column", async () => {
    const longPath = "repos/instafy-dev-demo/firmware/esp32/rust/src/runtime_telemetry.rs";

    await act(async () => {
      root.render(<MessageContent content={`Inspect \`${longPath}\` before editing.`} projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();
    expect(fileRef?.textContent?.trim()).toBe("runtime_telemetry.rs");
    expect(fileRef?.getAttribute("title")).toBe(
      `firmware/esp32/rust/src/runtime_telemetry.rs - Imported repo: instafy-dev-demo. Workspace path: ${longPath}`,
    );
    expect(fileRef?.getAttribute("aria-label")).toBe(
      "Open workspace file: firmware/esp32/rust/src/runtime_telemetry.rs in imported repo instafy-dev-demo",
    );
    expect(fileRef?.className).toContain("min-w-0");
    expect(fileRef?.className).toContain("overflow-hidden");

    const label = fileRef?.querySelector("span");
    expect(label?.className).toContain("min-w-0");
    expect(label?.className).toContain("max-w-full");
    expect(label?.className).toContain("truncate");
  });

  it("preserves line suffixes in compact workspace file labels", async () => {
    const longPathWithLine = "repos/instafy-dev-demo/firmware/esp32/rust/src/esp_idf_backend.rs:42";

    await act(async () => {
      root.render(<MessageContent content={`Open ${longPathWithLine}.`} projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();
    expect(fileRef?.textContent?.trim()).toBe("esp_idf_backend.rs:42");
    expect(fileRef?.getAttribute("title")).toBe(
      `firmware/esp32/rust/src/esp_idf_backend.rs:42 - Imported repo: instafy-dev-demo. Workspace path: ${longPathWithLine}`,
    );
    expect(fileRef?.getAttribute("data-workspace-path")).toBe(
      "repos/instafy-dev-demo/firmware/esp32/rust/src/esp_idf_backend.rs",
    );

    fileRef?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("code");
    expect((window as typeof window & { __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown }).__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toEqual({
      line: 42,
      path: "repos/instafy-dev-demo/firmware/esp32/rust/src/esp_idf_backend.rs",
      projectId: "project-1",
      returnTarget: "assistant",
    });
  });

  it("compacts absolute runtime workspace paths and opens the relative workspace target", async () => {
    const absolutePath =
      "/workspace/ba4d6198-fc9a-4b34-b39a-d5db02199172/shared/final-matrix-borsh-20260531a/source/borsh-ts/packages/borsh/src/index.ts:28";
    const relativePath =
      "shared/final-matrix-borsh-20260531a/source/borsh-ts/packages/borsh/src/index.ts";

    await act(async () => {
      root.render(<MessageContent content={`Inspect \`${absolutePath}\` before editing.`} projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();
    expect(fileRef?.textContent?.trim()).toBe("index.ts:28");
    expect(fileRef?.getAttribute("title")).toBe(`${relativePath}:28 - Original path: ${absolutePath}`);
    expect(fileRef?.getAttribute("aria-label")).toBe(`Open workspace file: ${relativePath}:28`);
    expect(fileRef?.getAttribute("data-workspace-path")).toBe(relativePath);

    fileRef?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("code");
    expect((window as typeof window & { __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown }).__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toEqual({
      line: 28,
      path: relativePath,
      projectId: "project-1",
      returnTarget: "assistant",
    });
  });

  it("shows imported repo provenance in workspace file previews", async () => {
    const importedPath = "repos/instafy-dev-demo/docs/handoff/current-state.md";
    readWorkspaceFile.mockResolvedValue({
      path: importedPath,
      size: 36,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7",
      isText: true,
    });

    await act(async () => {
      root.render(<MessageContent content={`Inspect ${importedPath}:4 before editing.`} projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();
    expect(fileRef?.textContent?.trim()).toBe("current-state.md:4");

    await act(async () => {
      fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      await Promise.resolve();
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("docs/handoff/current-state.md:4");
    expect(preview?.textContent).toContain("Imported repo: instafy-dev-demo");
    expect(preview?.textContent).not.toContain("text/markdown");
    expect(preview?.textContent).not.toContain("bytes");
    expect(preview?.querySelector('[data-line-number="4"]')?.className).toContain("bg-primary-50");
    expect(readWorkspaceFile).toHaveBeenCalledWith({
      projectId: "project-1",
      path: importedPath,
      runtimeId: null,
      timeoutMs: 5000,
    });
  });

  it("shows the useful end of long preview paths without noisy file metadata", async () => {
    const sourcePath = "sources/borsh-plan-first-1779940288109/packages/borsh/src/bigint.ts";
    const contentText = Array.from({ length: 22 }, (_, index) => {
      if (index === 11) {
        return "  return BigInt(`0x${hex}`);";
      }
      if (index === 14) {
        return "export function writeBufferLEBigInt(";
      }
      if (index === 15) {
        return "  num: bigint | number,";
      }
      return `Line ${index + 1}`;
    }).join("\n");
    readWorkspaceFile.mockResolvedValue({
      path: sourcePath,
      size: 4364,
      encoding: "base64",
      mimeType: "text/typescript",
      contentBase64: "",
      contentText,
      isText: true,
    });

    await act(async () => {
      root.render(<MessageContent content={`Inspect ${sourcePath}:15 before editing.`} projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();

    await act(async () => {
      fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 260));
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    const header = preview?.querySelector('[data-testid="chat-message-file-reference-preview-header"]');
    expect(header?.textContent).toBe("sources/…/packages/borsh/src/bigint.ts:15");
    expect(header?.getAttribute("title")).toBe(`${sourcePath}:15`);
    expect(preview?.textContent).not.toContain("text/typescript");
    expect(preview?.textContent).not.toContain("4,364 bytes");
    expect(preview?.textContent).not.toContain("preview truncated");
    const highlightedLine = preview?.querySelector('[data-line-number="15"]') as HTMLElement | null;
    expect(highlightedLine?.className).toContain("bg-primary-50");
    expect(highlightedLine?.style.gridTemplateColumns).toBe("2ch minmax(0, 1fr)");
    expect(
      Array.from(preview?.querySelectorAll('[data-syntax-kind="keyword"]') ?? []).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toContain("export");
    expect(preview?.querySelector('[data-syntax-kind="string"]')?.textContent).toBe("`0x${hex}`");
    expect(preview?.querySelector('[data-syntax-kind="type"]')?.textContent).toBe("BigInt");
  });

  it("keeps very long file names clipped while preserving the full path target", async () => {
    const longFileName =
      "generated_controller_snapshot_with_a_very_long_descriptive_filename_that_should_not_widen_chat.rs";
    const longPath = `repos/instafy-dev-demo/firmware/esp32/rust/src/${longFileName}`;

    await act(async () => {
      root.render(<MessageContent content={`Inspect ${longPath}.`} projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();
    expect(fileRef?.textContent?.trim()).toBe(longFileName);
    expect(fileRef?.getAttribute("title")).toBe(
      `firmware/esp32/rust/src/${longFileName} - Imported repo: instafy-dev-demo. Workspace path: ${longPath}`,
    );
    expect(fileRef?.getAttribute("aria-label")).toBe(
      `Open workspace file: firmware/esp32/rust/src/${longFileName} in imported repo instafy-dev-demo`,
    );
    expect(fileRef?.className).toContain("max-w-[14rem]");
    expect(fileRef?.className).toContain("overflow-hidden");
    expect(fileRef?.querySelector("span")?.className).toContain("truncate");

    fileRef?.click();

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("code");
    expect((window as typeof window & { __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown }).__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toEqual({
      path: longPath,
      projectId: "project-1",
      returnTarget: "assistant",
    });
  });

  it("previews workspace file references on hover without navigating", async () => {
    readWorkspaceFile.mockResolvedValue({
      path: "TODO.md",
      size: 24,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText: "# Demo TODO\n\nPreview body",
      isText: true,
    });

    await act(async () => {
      root.render(<MessageContent content="Inspect TODO.md before editing." projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();

    await act(async () => {
      fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 260));
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("# Demo TODO");
    expect(readWorkspaceFile).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "TODO.md",
      runtimeId: null,
      timeoutMs: 5000,
    });
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();
  });

  it("offers explicit preview and open actions from the file reference menu", async () => {
    readWorkspaceFile.mockResolvedValue({
      path: "TODO.md",
      size: 24,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText: "# Demo TODO\n\nMenu preview",
      isText: true,
    });

    await act(async () => {
      root.render(<MessageContent content="Inspect TODO.md:2 before editing." projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();

    await act(async () => {
      fileRef?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 90,
        }),
      );
    });

    let menu = container.querySelector('[data-testid="chat-message-file-reference-menu"]');
    expect(menu?.textContent).toContain("Preview");
    expect(menu?.textContent).toContain("Open");

    const previewButton = Array.from(menu?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Preview",
    );
    expect(previewButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      previewButton?.click();
      await Promise.resolve();
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("Menu preview");
    expect(readWorkspaceFile).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "TODO.md",
      runtimeId: null,
      timeoutMs: 5000,
    });
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();

    await act(async () => {
      fileRef?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 90,
        }),
      );
    });

    menu = container.querySelector('[data-testid="chat-message-file-reference-menu"]');
    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')).toBeNull();
    const openButton = Array.from(menu?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Open",
    );
    expect(openButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      openButton?.click();
    });

    expect(requestUrlPush).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("code");
    expect((window as typeof window & { __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: unknown }).__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toEqual({
      line: 2,
      path: "TODO.md",
      projectId: "project-1",
      returnTarget: "assistant",
    });
  });

  it("previews workspace file references around the cited line and highlights it", async () => {
    const contentText = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    readWorkspaceFile.mockResolvedValue({
      path: "TODO.md",
      size: contentText.length,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText,
      isText: true,
    });

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "chat-message-file-reference-preview-body" ? 80 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        return this.getAttribute("data-preview-line-highlighted") === "true" ? 120 : 0;
      },
    });

    try {
      await act(async () => {
        root.render(<MessageContent content="Inspect TODO.md:7 before editing." projectId="project-1" />);
      });

      const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
      expect(fileRef).not.toBeNull();

      await act(async () => {
        fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 260));
      });

      const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
      expect(preview?.textContent).toContain("Line 7");
      expect(preview?.querySelector('[data-line-number="1"]')).toBeNull();
      expect(preview?.querySelector('[data-line-number="2"]')?.textContent).toContain("Line 2");
      const highlightedLine = preview?.querySelector('[data-line-number="7"]');
      expect(highlightedLine).toBeInstanceOf(HTMLElement);
      expect(highlightedLine?.className).toContain("bg-primary-50");
      expect(highlightedLine?.getAttribute("data-preview-line-highlighted")).toBe("true");
      expect(
        (preview?.querySelector('[data-testid="chat-message-file-reference-preview-body"]') as HTMLElement | null)
          ?.scrollTop,
      ).toBe(80);
      expect(readWorkspaceFile).toHaveBeenCalledWith({
        projectId: "project-1",
        path: "TODO.md",
        runtimeId: null,
        timeoutMs: 5000,
      });
      expect(requestUrlPush).not.toHaveBeenCalled();
      expect(openPanelTab).not.toHaveBeenCalled();
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      } else {
        delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      }
      if (originalOffsetTop) {
        Object.defineProperty(HTMLElement.prototype, "offsetTop", originalOffsetTop);
      } else {
        delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
      }
    }
  });

  it("anchors above-positioned file previews to the hovered chip", async () => {
    const contentText = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n");
    readWorkspaceFile.mockResolvedValue({
      path: "current-state.md",
      size: contentText.length,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText,
      isText: true,
    });
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });

    try {
      await act(async () => {
        root.render(<MessageContent content="Inspect current-state.md:17 before editing." projectId="project-1" />);
      });

      const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
      expect(fileRef).not.toBeNull();
      fileRef!.getBoundingClientRect = vi.fn(
        () =>
          ({
            bottom: 690,
            height: 22,
            left: 120,
            right: 300,
            top: 668,
            width: 180,
            x: 120,
            y: 668,
            toJSON: () => ({}),
          }) as DOMRect,
      );

      await act(async () => {
        fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 260));
      });

      const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]') as HTMLElement | null;
      expect(preview).not.toBeNull();
      expect(preview?.style.top).toBe("");
      expect(preview?.style.bottom).toBe("62px");
      expect(preview?.querySelector('[data-line-number="17"]')?.className).toContain("bg-primary-50");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("keeps file previews above the sticky composer when lower viewport space is reserved", async () => {
    const contentText = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n");
    readWorkspaceFile.mockResolvedValue({
      path: "current-state.md",
      size: contentText.length,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText,
      isText: true,
    });
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    const composerOverlay = document.createElement("div");
    composerOverlay.setAttribute("data-testid", "chat-composer-overlay");
    composerOverlay.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 720,
          height: 160,
          left: 0,
          right: 480,
          top: 560,
          width: 480,
          x: 0,
          y: 560,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    document.body.appendChild(composerOverlay);

    try {
      await act(async () => {
        root.render(<MessageContent content="Inspect current-state.md:13 before editing." projectId="project-1" />);
      });

      const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
      expect(fileRef).not.toBeNull();
      fileRef!.getBoundingClientRect = vi.fn(
        () =>
          ({
            bottom: 352,
            height: 22,
            left: 120,
            right: 300,
            top: 330,
            width: 180,
            x: 120,
            y: 330,
            toJSON: () => ({}),
          }) as DOMRect,
      );

      await act(async () => {
        fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 260));
      });

      const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]') as HTMLElement | null;
      expect(preview).not.toBeNull();
      expect(preview?.style.top).toBe("");
      expect(preview?.style.bottom).toBe("400px");
    } finally {
      composerOverlay.remove();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("fails slow workspace file previews instead of spinning indefinitely", async () => {
    vi.useFakeTimers();
    readWorkspaceFile.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(<MessageContent content="Inspect current-state.md:17 before editing." projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();

    await act(async () => {
      fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(260);
    });

    let preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("Loading preview");

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("Preview is taking too long. Click the file to open it.");
    expect(readWorkspaceFile).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "current-state.md",
      runtimeId: null,
      timeoutMs: 5000,
    });
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();
  });

  it("replaces a stale adjacent file preview when hovering another file reference", async () => {
    vi.useFakeTimers();
    const contentText = Array.from({ length: 32 }, (_, index) => `Todo line ${index + 1}`).join("\n");
    readWorkspaceFile
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({
        path: "TODO.md",
        size: contentText.length,
        encoding: "base64",
        mimeType: "text/markdown",
        contentBase64: "",
        contentText,
        isText: true,
      });

    await act(async () => {
      root.render(<MessageContent content="Inspect TODO.md:26 and TODO.md:27 before editing." projectId="project-1" />);
    });

    const fileRefs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-message-file-reference-inline"]'),
    );
    expect(fileRefs).toHaveLength(2);

    await act(async () => {
      fileRefs[0]?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(260);
    });

    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')?.textContent).toContain(
      "Loading preview",
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')?.textContent).toContain(
      "Preview is taking too long",
    );

    await act(async () => {
      fileRefs[1]?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(260);
      await Promise.resolve();
      await Promise.resolve();
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("TODO.md:27");
    expect(preview?.textContent).toContain("Todo line 27");
    expect(preview?.querySelector('[data-line-number="27"]')?.className).toContain("bg-primary-50");
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();
  });

  it("reuses loaded file content when previewing another line in the same file", async () => {
    const contentText = Array.from({ length: 24 }, (_, index) => {
      const lineNumber = index + 1;
      if (lineNumber === 13) {
        return "The intended pattern is calibrated parity.";
      }
      if (lineNumber === 17) {
        return "- The current real-board BLE probes are green.";
      }
      return `Current state line ${lineNumber}`;
    }).join("\n");
    readWorkspaceFile.mockResolvedValue({
      path: "docs/handoff/current-state.md",
      size: contentText.length,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText,
      isText: true,
    });

    await act(async () => {
      root.render(
        <MessageContent
          content="Inspect docs/handoff/current-state.md:13 and docs/handoff/current-state.md:17."
          projectId="project-1"
        />,
      );
    });

    const fileRefs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-message-file-reference-inline"]'),
    );
    expect(fileRefs).toHaveLength(2);

    await act(async () => {
      fileRefs[0]?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')?.textContent).toContain(
      "calibrated parity",
    );

    await act(async () => {
      fileRefs[1]?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      await Promise.resolve();
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("current real-board BLE probes");
    expect(preview?.querySelector('[data-line-number="17"]')?.className).toContain("bg-primary-50");
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();
  });

  it("restarts an unfinished workspace file preview from the file action menu", async () => {
    vi.useFakeTimers();
    readWorkspaceFile
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({
        path: "TODO.md",
        size: 24,
        encoding: "base64",
        mimeType: "text/markdown",
        contentBase64: "",
        contentText: "# Demo TODO\n\nRestarted preview",
        isText: true,
      });

    await act(async () => {
      root.render(<MessageContent content="Inspect TODO.md before editing." projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();

    await act(async () => {
      fileRef?.parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(260);
    });

    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')?.textContent).toContain(
      "Loading preview",
    );

    await act(async () => {
      fileRef?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 90,
        }),
      );
    });

    expect(container.querySelector('[data-testid="chat-message-file-reference-preview"]')).toBeNull();
    const menu = container.querySelector('[data-testid="chat-message-file-reference-menu"]');
    const previewButton = Array.from(menu?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Preview",
    );
    expect(previewButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      previewButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("Restarted preview");
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();
  });

  it("previews workspace file references on touch hold without navigating", async () => {
    readWorkspaceFile.mockResolvedValue({
      path: "TODO.md",
      size: 24,
      encoding: "base64",
      mimeType: "text/markdown",
      contentBase64: "",
      contentText: "# Demo TODO\n\nTouch preview",
      isText: true,
    });

    await act(async () => {
      root.render(<MessageContent content="Inspect TODO.md before editing." projectId="project-1" />);
    });

    const fileRef = container.querySelector('[data-testid="chat-message-file-reference-inline"]') as HTMLButtonElement | null;
    expect(fileRef).not.toBeNull();

    const pointerDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
    const pointerUp = new MouseEvent("pointerup", { bubbles: true });
    Object.defineProperty(pointerUp, "pointerType", { value: "touch" });

    await act(async () => {
      fileRef?.dispatchEvent(pointerDown);
      await new Promise((resolve) => window.setTimeout(resolve, 560));
      fileRef?.dispatchEvent(pointerUp);
      fileRef?.click();
    });

    const preview = container.querySelector('[data-testid="chat-message-file-reference-preview"]');
    expect(preview?.textContent).toContain("Touch preview");
    expect(readWorkspaceFile).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "TODO.md",
      runtimeId: null,
      timeoutMs: 5000,
    });
    expect(requestUrlPush).not.toHaveBeenCalled();
    expect(openPanelTab).not.toHaveBeenCalled();
  });

  it("renders image attachments and inline references in the same user message", async () => {
    resolveConversationByController.mockImplementation((controllerId: string) => {
      if (controllerId === "thread-controller-123") {
        return { localId: "thread-local-123" };
      }
      return null;
    });
    const message: ChatMessage = {
      id: "user-message-with-image",
      role: "user",
      content: "Screenshot is attached. Details in [[thread:thread-controller-123|design pass]].",
      timestamp: Date.now(),
      metadata: {
        attachments: [
          {
            kind: "image",
            previewUrl: "data:image/png;base64,ZmFrZQ==",
            fileName: "reference.png",
          },
        ],
      },
    };

    await act(async () => {
      root.render(<UserMessageBubble message={message} />);
    });

    expect(container.querySelector('[data-testid="chat-image-attachment-thumbnail"]')).not.toBeNull();
    const ref = container.querySelector('[data-testid="chat-message-inline-reference"]') as HTMLButtonElement | null;
    expect(ref?.textContent?.trim()).toBe("design pass");
    expect(ref?.getAttribute("aria-label")).toBe("Open referenced thread: design pass");
  });

  it("does not render a workflow spine for plain assistant answers", async () => {
    const message: ChatMessage = {
      id: "plain-answer",
      role: "assistant",
      content: "2",
      timestamp: Date.now(),
      metadata: {
        details: {
          usage: {
            input_tokens: 123,
            cached_input_tokens: 45,
            output_tokens: 6,
          },
          context: {
            mode: "stateless_full",
            estimatedPromptTokens: 789,
          },
        },
      },
    };

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    expect(container.querySelector('[data-testid="chat-bubble-assistant"]')).not.toBeNull();
    expect(container.textContent).toContain("2");
    expect(container.textContent).not.toContain("Input");
    expect(container.textContent).not.toContain("Cached");
    expect(container.textContent).not.toContain("Output");
    expect(container.textContent).not.toContain("Stateless replay");
    expect(container.querySelector('[data-testid="thread-spine"]')).toBeNull();
  });

  it("renders controller runtime alerts as notices instead of assistant bubbles", async () => {
    const message: ChatMessage = {
      id: "runtime-alert",
      role: "assistant",
      content:
        "Runtime agent has not connected yet. Start the runtime (e.g. run `pnpm stack:up`) so queued jobs can proceed.",
      timestamp: Date.now(),
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        runId: "run-1",
        details: {
          reason: "runtime_not_ready",
        },
      },
    };

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    const notice = container.querySelector('[data-testid="chat-controller-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("data-message-type")).toBe("runtime_alert");
    expect(notice?.textContent).toContain("Starting the workspace");
    expect(notice?.textContent).toContain("queued request will continue automatically");
    expect(notice?.textContent).not.toContain("try again");
    expect(notice?.textContent).not.toContain("pnpm stack:up");
    expect(container.querySelector('[data-testid="chat-bubble-assistant"]')).toBeNull();
  });

  it("demotes a runtime alert to a quiet history line while a workspace start is live", async () => {
    const message: ChatMessage = {
      id: "runtime-alert-superseded",
      role: "assistant",
      content:
        "Runtime agent has not connected yet. Start the runtime (e.g. run `pnpm stack:up`) so queued jobs can proceed.",
      timestamp: Date.now(),
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        runId: "run-1",
        details: {
          reason: "runtime_not_ready",
        },
      },
    };

    await act(async () => {
      root.render(
        <ChatRuntimeActivityContext.Provider value={{ workspaceStarting: true }}>
          <AssistantMessageEntry message={message} conversationMessages={[message]} />
        </ChatRuntimeActivityContext.Provider>,
      );
    });

    const notice = container.querySelector('[data-testid="chat-controller-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector('[data-runtime-alert-superseded="true"]')).not.toBeNull();
    expect(notice?.textContent).toContain("A new workspace start is in progress");
    expect(notice?.textContent).not.toContain("queued request will continue automatically");
  });

  it("does not render a human-authored nested runtime-alert claim as a controller notice", async () => {
    const message: ChatMessage = {
      id: "forged-runtime-alert",
      role: "assistant",
      authorId: "user-1",
      content: "The runtime is definitely broken.",
      timestamp: Date.now(),
      metadata: {
        agent: { handle: "reviewer" },
        details: {
          messageType: "runtime_alert",
          reason: "runtime_not_ready",
        },
      },
    };

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    expect(container.querySelector('[data-testid="chat-controller-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-bubble-assistant"]')).not.toBeNull();
    expect(container.textContent).toContain(message.content);
  });

  it("renders top-level multi-agent plan messages as inline live team status", async () => {
    const message: ChatMessage = {
      id: "multi-agent-plan",
      role: "assistant",
      content: "I'm splitting this into workstreams.",
      timestamp: Date.now(),
      messageType: "multi_agent_plan",
      metadata: {
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          kind: "runtime_selection",
          runtimeId: "runtime-1",
          displayName: "Hosted Runtime",
          messageType: "multi_agent_plan",
          details: {
            type: "multi_agent_plan",
            mode: "read_only",
            thresholdReason: "Explicit team workflow with sibling scopes.",
            agents: [
              {
                handle: "front",
                label: "Frontend review",
                scopeSummary: "Auth/session UI",
                writeScope: { mode: "read_only" },
              },
              {
                handle: "api",
                label: "API review",
                scopeSummary: "Authorization routes",
                writeScope: { mode: "read_only" },
              },
            ],
            lead: {
              leadHandle: "octo",
              continuationPrompt: "Review sibling outputs and decide whether to answer.",
              expectedReportFormat: "Severity-ranked findings.",
            },
          },
        },
      },
    };
    const longWorkerEvidence = `Frontend evidence: session state is client-only and no sensitive token was found. ${"Additional scoped observation. ".repeat(
      28,
    )}Tail detail: route guards were not present in the inspected files.`;
    const workerMessage: ChatMessage = {
      id: "front-result",
      role: "assistant",
      content: longWorkerEvidence,
      timestamp: Date.now() + 1,
      metadata: {
        source: "agent",
        outcome: "succeeded",
        jobId: "front-job-1",
        agent: { handle: "front" },
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    };
    const leadMessage: ChatMessage = {
      id: "lead-result",
      role: "assistant",
      content: "Lead report is ready.",
      timestamp: Date.now() + 2,
      metadata: {
        source: "agent",
        outcome: "succeeded",
        jobId: "lead-job-1",
        agent: { handle: "octo" },
        multiAgentPlan: {
          role: "lead_continuation",
          groupId: "group-1",
        },
      },
    };
    const lateWorkerUpdate: ChatMessage = {
      id: "front-token-update",
      role: "assistant",
      content: "Token usage update after completion.",
      timestamp: Date.now() + 3,
      metadata: {
        source: "agent",
        kind: "update",
        outcome: "in_progress",
        jobId: "front-job-1",
        agent: { handle: "front" },
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    };
    const lateLeadUpdate: ChatMessage = {
      id: "lead-token-update",
      role: "assistant",
      content: "Lead token usage update after completion.",
      timestamp: Date.now() + 4,
      metadata: {
        source: "agent",
        kind: "update",
        outcome: "in_progress",
        jobId: "lead-job-1",
        agent: { handle: "octo" },
        multiAgentPlan: {
          role: "lead_continuation",
          groupId: "group-1",
        },
      },
    };

    await act(async () => {
      root.render(
        <AssistantMessageEntry
          message={message}
          conversationMessages={[message, workerMessage, leadMessage, lateWorkerUpdate, lateLeadUpdate]}
        />,
      );
    });

    const statusStrip = container.querySelector('[data-testid="multi-agent-inline-status"]');
    expect(statusStrip).not.toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-plan-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-spine"]')).not.toBeNull();
    expect(container.textContent).toContain("I'm splitting this into workstreams.");
    expect(statusStrip?.getAttribute("aria-label")).toBe("Lead ready · 1/2 lanes");
    expect(container.textContent).not.toContain("Explicit team workflow");
    expect(container.textContent).toContain("@front");
    expect(container.textContent).not.toContain("Auth/session UI");
    expect(container.textContent).toContain("@octo");
    expect(container.textContent).not.toContain("Lead: @octo");
    expect(container.textContent).not.toContain("Severity-ranked findings.");
    expect(container.textContent).not.toContain("Final answer posted below");
    expect(container.textContent).not.toContain("Frontend evidence:");
    expect(container.textContent).not.toContain("working");
    expect(container.textContent).not.toContain("read-only");
    expect(container.textContent).not.toContain("read only");
    expect(container.textContent).not.toContain("Evidence");
    expect(container.textContent).not.toContain("done");

    const frontRow = container.querySelector(
      '[data-testid="multi-agent-evidence-row"][data-agent-handle="@front"]',
    ) as HTMLButtonElement | null;
    expect(frontRow).not.toBeNull();
    expect(frontRow?.getAttribute("aria-label")).toBe("Show details for @front; status done");
    expect(frontRow?.textContent).not.toContain("done");
    expect(frontRow?.textContent).not.toContain("read-only");
    expect(frontRow?.textContent).not.toContain("read only");
    expect(frontRow?.textContent).not.toContain("Evidence");
    expect(frontRow?.textContent).not.toContain("Details");

    await act(async () => {
      frontRow?.click();
    });

    expect(container.querySelector('[data-testid="multi-agent-evidence-detail"]')?.textContent).toContain(
      "session state is client-only",
    );
    expect(container.querySelector('[data-testid="multi-agent-evidence-detail"]')?.textContent).not.toContain(
      "Tail detail",
    );

    const fullToggle = container.querySelector(
      '[data-testid="multi-agent-evidence-full-toggle"]',
    ) as HTMLButtonElement | null;
    expect(fullToggle).not.toBeNull();
    expect(fullToggle?.textContent).toContain("Full note");

    await act(async () => {
      fullToggle?.click();
    });

    expect(container.querySelector('[data-testid="multi-agent-evidence-detail"]')?.textContent).toContain(
      "Tail detail",
    );
  });

  // jsdom cannot lay out, so these assert structure/classes rather than
  // measured pixel widths (#207: the bubble shell's content child needs an
  // explicit width to wrap instead of overflowing, and prose needs a capped
  // measure). Real width assertions live in the Playwright component suite.
  describe("bubble width and prose measure (#207)", () => {
    it("gives the assistant bubble's content wrapper an explicit full-width class and caps the paragraph's measure", async () => {
      const longParagraph =
        "This is a long unbroken runbook paragraph that keeps going and going without any line breaks, exactly the kind of prose that used to overflow the chat bubble shell instead of wrapping inside it because the content wrapper had no width of its own.";
      const message: ChatMessage = {
        id: "long-prose-answer",
        role: "assistant",
        content: longParagraph,
        timestamp: Date.now(),
      };

      await act(async () => {
        root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
      });

      const bubble = container.querySelector('[data-testid="chat-bubble-assistant"]');
      expect(bubble).not.toBeNull();
      // NotchedMessageShell wraps every child (text, files, chip rows) in a
      // single content div; it must carry an explicit width so it resolves
      // against the shell's already-clamped size instead of the fit-content
      // sizing a plain flex-column `items-start` child would otherwise get.
      const contentWrapper = bubble?.firstElementChild as HTMLElement | null;
      expect(contentWrapper?.className).toContain("w-full");

      const paragraph = bubble?.querySelector("p");
      expect(paragraph?.textContent).toBe(longParagraph);
      expect(paragraph?.className).toContain("max-w-[70ch]");
    });

    it("keeps the break and overflow-wrap classes on a paragraph with a very long unbroken token", async () => {
      const longToken = "x".repeat(200);
      const message: ChatMessage = {
        id: "long-token-answer",
        role: "assistant",
        content: `See ${longToken} for details.`,
        timestamp: Date.now(),
      };

      await act(async () => {
        root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
      });

      const paragraph = container.querySelector('[data-testid="chat-bubble-assistant"] p');
      expect(paragraph?.textContent).toContain(longToken);
      expect(paragraph?.className).toContain("max-w-[70ch]");
      expect(paragraph?.className).toContain("break-words");
      expect(paragraph?.className).toContain("[overflow-wrap:anywhere]");
    });

    it("caps list items to the prose measure but leaves fenced code blocks at full width", async () => {
      const message: ChatMessage = {
        id: "list-and-code-answer",
        role: "assistant",
        content:
          "Steps:\n- Inspect the long-running bubble shell for missing width constraints on its content wrapper\n- Run the checks\n```sh\npnpm --filter @instafy/frontend test:unit\n```",
        timestamp: Date.now(),
      };

      await act(async () => {
        root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
      });

      const listItems = Array.from(
        container.querySelectorAll('[data-testid="chat-message-list"] li'),
      ) as HTMLElement[];
      expect(listItems.length).toBeGreaterThan(0);
      for (const item of listItems) {
        expect(item.className).toContain("max-w-[70ch]");
      }

      const codeBlock = container.querySelector('[data-testid="chat-message-code-block"]');
      expect(codeBlock).not.toBeNull();
      expect(codeBlock?.textContent).toContain("pnpm --filter @instafy/frontend test:unit");
      expect(codeBlock?.className).not.toContain("max-w-[70ch]");
      // The code block keeps its own full-width class untouched.
      expect(codeBlock?.className).toContain("max-w-full");
    });
  });
});
