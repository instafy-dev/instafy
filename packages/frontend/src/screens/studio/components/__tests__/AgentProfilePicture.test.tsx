// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProfileModal } from "../AgentProfileModal";

const onSave = vi.fn();
const onClose = vi.fn();
function Editor({ pending = false, dirty = true }: { pending?: boolean; dirty?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("https://example.test/original.png");
  return <AgentProfileModal isOpen mode="edit" title="Edit bot" pending={pending} dirty={dirty}
    handle="helper" displayName="Helper" onHandleChange={() => {}} onDisplayNameChange={() => {}}
    avatarImageUrl={url} onAvatarImageUrlChange={setUrl} avatarFile={file} onAvatarFileChange={setFile}
    bio="Public introduction" onBioChange={() => {}} description="Answer concisely." onDescriptionChange={() => {}}
    onSave={onSave} onClose={onClose} />;
}

describe("bot profile picture editor", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:local-picture");
    URL.revokeObjectURL = vi.fn();
    onSave.mockReset(); onClose.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const pictureInput = () => document.querySelector<HTMLInputElement>('[data-testid="agent-profile-picture-input"]')!;
  async function choose(file: File) {
    await act(async () => {
      Object.defineProperty(pictureInput(), "files", { configurable: true, value: [file] });
      pictureInput().dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function render(props: ComponentProps<typeof Editor> = {}) {
    await act(async () => root.render(<Editor {...props} />));
  }
  it("opens the native chooser and shows a local preview without saving", async () => {
    await render();
    expect(document.querySelector('[data-testid="agent-profile-avatar-url-input"]')).toBeNull();
    const click = vi.spyOn(pictureInput(), "click");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Change bot picture"]')!.click());
    expect(click).toHaveBeenCalledOnce();
    await choose(new File(["picture"], "bot.png", { type: "image/png" }));
    expect(document.querySelector('img[src="blob:local-picture"]')).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#agent-profile-display-name')?.labels?.[0]?.textContent).toBe("Display name");
    const behavior = document.querySelector('[aria-label="Bot behavior"]')!;
    expect(behavior.querySelector('#agent-profile-description')).not.toBeNull();
    expect(behavior.querySelector('#agent-profile-bio')).toBeNull();
  });
  it("rejects unsupported and oversized files while keeping the current picture", async () => {
    await render();
    await choose(new File(["<svg/>"], "bot.svg", { type: "image/svg+xml" }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("PNG, JPEG or WebP");
    await choose(new File([new Uint8Array(2097153)], "big.png", { type: "image/png" }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("2 MB");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector('img[src="https://example.test/original.png"]')).not.toBeNull();
  });
  it("removes the picture as a draft and releases its local preview", async () => {
    await render();
    await choose(new File(["picture"], "bot.png", { type: "image/png" }));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === "Remove picture")!.click());
    expect(document.querySelector('img[src="blob:local-picture"]')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-picture");
    expect(document.querySelector('[aria-label="Upload bot picture"]')).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("disables unchanged saves and all edit/close controls during saving", async () => {
    await render({ dirty: false });
    expect(document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-save"]')?.disabled).toBe(true);
    await render({ pending: true });
    expect(pictureInput().disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Change bot picture"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#agent-profile-display-name')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.disabled).toBe(true);
  });
});
