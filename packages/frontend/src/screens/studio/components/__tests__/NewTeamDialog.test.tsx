// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTeamDialog } from "../NewTeamDialog";

const mocks = vi.hoisted(() => ({ create: vi.fn(), upload: vi.fn(), update: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { organizations: { create: mocks.create } } }));
vi.mock("../../../../lib/supabaseStorage", () => ({ uploadOrgAvatar: mocks.upload }));
vi.mock("../../../../services/runtimeController/projects", () => ({ updateControllerOrganization: mocks.update }));
vi.mock("../../../../components/aria/StudioModal", () => ({ StudioDialogModal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div> }));
const created = { id: "team-new", slug: "new-team", name: "New team", role: "owner" };

describe("new team picture onboarding", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onCreated = vi.fn();
  const onClose = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.create.mockReset().mockResolvedValue(created);
    mocks.upload.mockReset().mockResolvedValue("https://example.test/team.png");
    mocks.update.mockReset().mockResolvedValue(true);
    onCreated.mockReset(); onClose.mockReset();
    URL.createObjectURL = vi.fn().mockReturnValue("blob:preview");
    URL.revokeObjectURL = vi.fn();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  async function render(allowCustomSlug = false) {
    await act(async () => root.render(<NewTeamDialog open allowCustomSlug={allowCustomSlug} onCreated={onCreated} onClose={onClose} />));
    await input(allowCustomSlug ? "project-launcher-org-name-input" : "sidebar-new-team-name", "New team");
  }
  async function input(id: string, value: string) {
    await act(async () => {
      const element = container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function choose(file = new File(["image"], "team.png", { type: "image/png" })) {
    await act(async () => {
      const element = container.querySelector<HTMLInputElement>('[data-testid="new-team-picture-input"]')!;
      Object.defineProperty(element, "files", { value: [file], configurable: true });
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  it("creates a team without requiring a picture", async () => {
    await render(); await submit();
    expect(mocks.create).toHaveBeenCalledWith({ orgName: "New team" });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("preserves optional custom slugs for creation from the space launcher", async () => {
    await render(true); await input("project-launcher-org-slug-input", "my-custom-team"); await submit();
    expect(mocks.create).toHaveBeenCalledWith({ orgName: "New team", orgSlug: "my-custom-team" });
  });
  it("uploads only to the newly created organization and returns the saved avatar", async () => {
    await render(); await choose(); await submit();
    expect(mocks.upload).toHaveBeenCalledWith({ orgId: "team-new", file: expect.any(File) });
    expect(mocks.update).toHaveBeenCalledWith("team-new", { avatarUrl: "https://example.test/team.png" });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ ...created, avatarUrl: "https://example.test/team.png" });
  });
  it("retries a failed avatar save without creating another organization", async () => {
    mocks.update.mockResolvedValueOnce(false);
    await render(); await choose(); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Team created, but its picture wasn't saved");
    expect(onCreated).not.toHaveBeenCalled();
    await submit();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
  it("allows continuing with the existing team after upload failure", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("Upload failed"));
    await render(); await choose(); await submit();
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Continue without picture")!;
    await act(async () => { button.click(); button.click(); });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
  });
  it("rejects unsupported and oversized files before any upload", async () => {
    await render();
    await choose(new File(["text"], "team.txt", { type: "text/plain" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("must be an image");
    await choose(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("2 MB or smaller");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not create or upload twice on repeated submit while creation is pending", async () => {
    let resolve!: (value: typeof created) => void;
    mocks.create.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    await render(); await choose(); await submit(); await submit();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close new team"]')?.disabled).toBe(true);
    await act(async () => resolve(created));
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
  it("includes the chosen accent in creation and previews it before saving", async () => {
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('input[value="violet"]')!.click());
    expect(container.querySelector('[data-testid="new-team-picture"] [data-org-accent]')?.getAttribute("data-org-accent")).toBe("violet");
    mocks.create.mockResolvedValue({ ...created, accentColor: "violet" });
    await submit();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ orgName: "New team", accentColor: "violet" });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ ...created, accentColor: "violet" });
  });
  it("shows the saved color during picture retry when idempotent creation returns an existing neutral team", async () => {
    mocks.create.mockResolvedValue({ ...created, accentColor: null });
    mocks.upload.mockRejectedValueOnce(new Error("Upload failed"));
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('input[value="violet"]')!.click());
    await choose(); await submit();
    expect(container.querySelector<HTMLInputElement>('input[value="slate"]')!.checked).toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>('[data-testid="team-accent-picker"]')!.disabled).toBe(true);
    await submit();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ ...created, accentColor: null, avatarUrl: "https://example.test/team.png" });
  });

});
