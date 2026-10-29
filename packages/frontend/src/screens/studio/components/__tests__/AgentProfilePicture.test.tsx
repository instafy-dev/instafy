// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classTokens, expectAiTile, expectCanonicalOctoCoin, expectHatchling } from "../../../../components/__tests__/octoCoinExpectations";
import { AI_TILE_SHAPE_CLASS } from "../../../../components/OctoCoin";
import type { Hatchling } from "../../../../utils/aiFace";
import { AgentProfileModal, type AgentProfileModalMode } from "../AgentProfileModal";

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
  it("shapes the photo target like the bot's AI tile, so hover and focus never show past its corners", async () => {
    // One rule for faces (docs/Brand.md): a bot is an AI, so the button
    // takes the 64px tile's own corners, not a team's 12px or a person's circle.
    await render();
    const button = document.querySelector('button[aria-label="Change bot picture"]');
    expect(classTokens(button)).toEqual(expect.arrayContaining(["h-16", "w-16", AI_TILE_SHAPE_CLASS]));
    expect(classTokens(button).filter((token) => /^rounded-(none|md|lg|xl|2xl|full)$/.test(token))).toEqual([]);
    expectAiTile(button?.firstElementChild);
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

const onFaceChange = vi.fn();
function FaceEditor({ mode = "create", initialFace = 8, picture = "", pending = false }: {
  mode?: AgentProfileModalMode; initialFace?: Hatchling | null; picture?: string; pending?: boolean;
}) {
  const [face, setFace] = useState<Hatchling | null>(initialFace);
  const [url, setUrl] = useState(picture);
  return <AgentProfileModal isOpen mode={mode} title="New agent" pending={pending}
    handle={mode === "octo" ? "@octo" : "@writer"} displayName="" onHandleChange={() => {}} onDisplayNameChange={() => {}}
    avatarImageUrl={url} onAvatarImageUrlChange={setUrl} onAvatarFileChange={() => {}}
    avatarSeed={mode === "octo" ? "octo" : undefined}
    face={face} onFaceChange={(next) => { onFaceChange(next); setFace(next); }}
    description="" onDescriptionChange={() => {}} onSave={onSave} onClose={onClose} />;
}

describe("bot face picker", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onFaceChange.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const picker = () => document.querySelector<HTMLFieldSetElement>('[data-testid="agent-face-picker"]');
  const preview = () => document.querySelector('button[aria-label$="bot picture"]')?.firstElementChild ?? null;
  const radios = () => Array.from(picker()?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []);

  it("offers all eight faces as named radios, with the bot's own face chosen and previewed", async () => {
    await act(async () => root.render(<FaceEditor initialFace={8} />));
    expect(picker()?.querySelector("legend")?.textContent).toBe("Face");
    expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual(
      ["Hooray", "Drift", "Kick", "Twirl", "Wave", "Catch", "Rest", "Swim"],
    );
    // One group: arrow keys move between faces, and only one is checked.
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
    expect(radios().filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["8"]);
    expect(radios().map((radio) => expectHatchling(radio.nextElementSibling))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // Each choice is a 44px target edged on the AI tile's corners when chosen.
    const choice = radios()[0]?.parentElement;
    expect(classTokens(choice)).toEqual(expect.arrayContaining(["h-11", "w-11", AI_TILE_SHAPE_CLASS, "has-checked:border-primary-600"]));
    expect(expectHatchling(preview())).toBe("8");
  });

  it("previews the face picked, before anything is saved", async () => {
    await act(async () => root.render(<FaceEditor initialFace={8} />));
    await act(async () => radios()[2]!.click());
    expect(onFaceChange).toHaveBeenCalledExactlyOnceWith(3);
    expect(radios().filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["3"]);
    expect(expectHatchling(preview())).toBe("3");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("puts the faces away behind a picture, and offers them again once it is removed", async () => {
    await act(async () => root.render(<FaceEditor mode="edit" initialFace={5} picture="https://example.test/bot.png" />));
    expect(picker()).toBeNull();
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe("https://example.test/bot.png");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove picture")!.click());
    expect(radios().filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["5"]);
    expect(expectHatchling(preview())).toBe("5");
    // The removed button took focus with it; the face the bot wears now has
    // it, rather than the top of the dialog.
    expect(document.activeElement).toBe(radios()[4]);
  });

  it("hands focus to Octo's picture button once its picture is removed, since Octo has no faces", async () => {
    await act(async () => root.render(<FaceEditor mode="octo" initialFace={null} picture="https://example.test/octo.png" />));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove picture")!.click());
    expect(document.activeElement).toBe(document.querySelector('button[aria-label="Upload bot picture"]'));
  });

  it("disables the faces while saving", async () => {
    await act(async () => root.render(<FaceEditor pending />));
    expect(picker()?.disabled).toBe(true);
  });

  it("keeps Octo's editor on Octo's own tile, with no faces to pick", async () => {
    await act(async () => root.render(<FaceEditor mode="octo" initialFace={null} />));
    expect(picker()).toBeNull();
    expectCanonicalOctoCoin(preview());
  });
});
