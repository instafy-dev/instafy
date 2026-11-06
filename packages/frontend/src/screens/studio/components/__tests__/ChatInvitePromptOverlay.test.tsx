// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInvitePromptOverlay } from "../ChatInvitePromptOverlay";
import { useStudioModalNativeOcclusion } from "../../../../components/aria/studioModalOcclusion";

const nativeBack = vi.hoisted(() => ({ handler: null as (() => void) | null }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android", isNativePlatform: () => false } }));
vi.mock("@capacitor/app", () => ({ App: {
  addListener: async (_event: string, handler: () => void) => {
    nativeBack.handler = handler;
    return { remove: async () => { nativeBack.handler = null; } };
  },
} }));

type Props = ComponentProps<typeof ChatInvitePromptOverlay>;
const createProps = (overrides: Partial<Props> = {}): Props => ({
  invitePrompt: { missingUsers: [{ displayName: "Alex Rivera", handle: "alex" }] },
  invitePromptBusy: false,
  onClose: vi.fn(),
  onSendWithout: vi.fn(),
  onInviteAndSend: vi.fn(),
  ...overrides,
});

function OcclusionProbe() {
  return <output data-testid="native-occlusion">{String(useStudioModalNativeOcclusion())}</output>;
}

describe("ChatInvitePromptOverlay", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    nativeBack.handler = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (props: Props) => {
    await act(async () => root.render(<><OcclusionProbe /><ChatInvitePromptOverlay {...props} /></>));
    await act(async () => { await new Promise(requestAnimationFrame); });
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Invite teammate"]')!;
  const button = (name: string) => [...dialog().querySelectorAll("button")].find((node) => node.textContent === name)!;
  const closeButton = () => dialog().querySelector<HTMLButtonElement>('[aria-label="Cancel invitation"]')!;
  const escape = async () => act(async () => {
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  const outside = async () => act(async () => {
    const overlay = document.querySelector<HTMLElement>('[data-testid="chat-invite-prompt"]')!;
    overlay.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    overlay.click();
  });

  it("renders only for a pending invitation and covers native browser content while open", async () => {
    const props = createProps({ invitePrompt: null });
    await render(props);
    expect(dialog()).toBeNull();
    expect(host.querySelector("output")?.textContent).toBe("false");
    await render(createProps());
    expect(dialog()).not.toBeNull();
    expect(dialog().textContent).toContain("Alex Rivera can’t see this conversation yet.");
    expect(host.querySelector("output")?.textContent).toBe("true");
    await render(props);
    expect(host.querySelector("output")?.textContent).toBe("false");
  });

  it("names every missing teammate without exposing a blank name", async () => {
    await render(createProps({ invitePrompt: { missingUsers: [{ displayName: "Alex" }, { displayName: "", handle: "sam" }, {}] } }));
    expect(dialog().textContent).toContain("These teammates can’t see this conversation yet: Alex, sam, Teammate.");
  });

  it.each(["Send without @", "Invite & send"])("only runs the requested %s action", async (name) => {
    const props = createProps();
    await render(props);
    await act(async () => button(name).click());
    expect(props.onSendWithout).toHaveBeenCalledTimes(name === "Send without @" ? 1 : 0);
    expect(props.onInviteAndSend).toHaveBeenCalledTimes(name === "Invite & send" ? 1 : 0);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each(["close", "escape", "native", "outside"])("cancels through %s without sending the draft", async (method) => {
    const props = createProps();
    await render(props);
    if (method === "close") await act(async () => closeButton().click());
    else if (method === "escape") await escape();
    else if (method === "native") await act(async () => nativeBack.handler?.());
    else await outside();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSendWithout).not.toHaveBeenCalled();
    expect(props.onInviteAndSend).not.toHaveBeenCalled();
  });

  it("keeps the pending action focused and blocks repeated submission and all dismissal paths", async () => {
    const props = createProps();
    await render(props);
    const submit = button("Invite & send");
    submit.focus();
    await act(async () => submit.click());
    expect(props.onInviteAndSend).toHaveBeenCalledOnce();
    await render({ ...props, invitePromptBusy: true });
    expect(document.activeElement).toBe(submit);
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(closeButton().disabled).toBe(true);
    expect(button("Send without @").disabled).toBe(true);
    await act(async () => {
      submit.click();
      closeButton().click();
      button("Send without @").click();
      nativeBack.handler?.();
    });
    await escape();
    await outside();
    expect(props.onInviteAndSend).toHaveBeenCalledOnce();
    expect(props.onSendWithout).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    await render(props);
    await act(async () => nativeBack.handler?.());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each(["close", "escape"])("returns focus to the opener and preserves its draft after %s", async (method) => {
    const props = createProps();
    const opener = document.createElement("button");
    opener.textContent = "Send draft";
    const draft = document.createElement("textarea");
    draft.value = "@alex Please review this.";
    document.body.append(opener, draft);
    opener.focus();
    await act(async () => root.render(<ChatInvitePromptOverlay {...props} />));
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(dialog().contains(document.activeElement)).toBe(true);
    if (method === "close") await act(async () => {
      const close = closeButton();
      close.focus();
      // Exercise a pointer press; HTMLElement.click() emits a virtual click
      // whose deferred focus does not model mouse-up dismissal in jsdom.
      for (const type of ["mousedown", "mouseup", "click"]) {
        close.dispatchEvent(new MouseEvent(type, { button: 0, detail: 1, bubbles: true }));
      }
    });
    else await escape();
    expect(props.onClose).toHaveBeenCalledOnce();
    await act(async () => root.render(<ChatInvitePromptOverlay {...props} invitePrompt={null} />));
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(document.activeElement).toBe(opener);
    expect(draft.value).toBe("@alex Please review this.");
    expect(props.onInviteAndSend).not.toHaveBeenCalled();
  });
});
