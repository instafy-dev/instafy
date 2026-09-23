// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDraftsProvider } from "../../workspace/StudioDrafts";
import { SettingsNavigationLabelContext } from "../../components/SettingsNavigationLabelContext";
import { ProfileEditor } from "../ProfileEditor";

const mocks = vi.hoisted(() => ({
  user: { id: "profile-user", email: "teammate@example.test" } as { id: string; email: string } | null,
  profile: { fullName: "Alex Teammate", avatarUrl: "https://example.test/photo.png" } as {
    fullName: string | null;
    avatarUrl: string | null;
    bio?: string | null;
  },
  updateProfile: vi.fn(),
  showStatus: vi.fn(),
  error: null as string | null,
  loading: false,
  refresh: vi.fn()
}));

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../ProfileProvider", () => ({
  useProfile: () => ({ profile: mocks.profile, updateProfile: mocks.updateProfile, loading: mocks.loading,
    error: mocks.error, refresh: mocks.refresh })
}));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));

describe("ProfileEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.user = { id: "profile-user", email: "teammate@example.test" };
    mocks.profile = { fullName: "Alex Teammate", avatarUrl: "https://example.test/photo.png" };
    mocks.updateProfile.mockReset().mockResolvedValue({ success: true });
    mocks.showStatus.mockReset();
    mocks.error = null;
    mocks.loading = false;
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(onDone?: () => void) {
    await act(async () => root.render(<ProfileEditor onDone={onDone} />));
  }

  function button(label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
    expect(found, label).toBeDefined();
    return found!;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  async function type(id: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
      Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function chooseFile(file: File) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("keeps the profile introduction and draft when its heading is already shown by the picker", async () => {
    const show = (label: string | null) => act(async () => root.render(
      <SettingsNavigationLabelContext.Provider value={label}><ProfileEditor /></SettingsNavigationLabelContext.Provider>,
    ));
    await show(null);
    await type("profile-display-name", "Draft name");
    expect(container.querySelector("h3")?.classList.contains("sr-only")).toBe(false);
    await show("Profile");
    expect(container.querySelector("h3")?.classList.contains("sr-only")).toBe(true);
    expect(container.querySelector("h3")?.hasAttribute("aria-hidden")).toBe(false);
    expect(container.textContent).toContain("Introduce yourself to teammates with a name, photo, and short bio.");
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")?.value).toBe("Draft name");
    await show(null);
    expect(container.querySelector("h3")?.classList.contains("sr-only")).toBe(false);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("retains an unsaved profile through utility and settings-category navigation", async () => {
    const show = (visible: boolean, account = "a") => act(async () => root.render(
      <StudioDraftsProvider key={account}>{visible ? <ProfileEditor /> : <div>Credits</div>}</StudioDraftsProvider>,
    ));
    await show(true);
    await type("profile-display-name", "Draft name");
    await type("profile-bio", "Draft bio");
    await show(false);
    mocks.profile = { ...mocks.profile, avatarUrl: "https://example.test/new-photo.png" };
    await show(true);
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")!.value).toBe("Draft name");
    expect(container.querySelector<HTMLTextAreaElement>("#profile-bio")!.value).toBe("Draft bio");
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Cancel");
    await show(false);
    await show(true);
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")!.value).toBe("Alex Teammate");
    await type("profile-display-name", "Another draft");
    await show(true, "b");
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")!.value).toBe("Alex Teammate");
  });

  it("saves and clears the optional About text without changing the name or photo", async () => {
    await render();
    await type("profile-bio", "  Builds and releases.\nHappy to help.  ");
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenLastCalledWith({
      fullName: "Alex Teammate", avatarUrl: mocks.profile.avatarUrl,
      bio: "Builds and releases.\nHappy to help."
    });
    mocks.profile.bio = "Existing bio";
    await render();
    await type("profile-bio", "");
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenLastCalledWith({
      fullName: "Alex Teammate", avatarUrl: mocks.profile.avatarUrl, bio: null
    });
  });

  it("shows a character count and blocks an overlong bio while allowing 500 emoji", async () => {
    await render();
    await type("profile-bio", "🛠".repeat(500));
    expect(button("Save profile").disabled).toBe(false);
    expect(container.querySelector("#profile-bio-count")?.textContent).toBe("500/500");
    await type("profile-bio", "x".repeat(501));
    expect(button("Save profile").disabled).toBe(true);
    expect(container.querySelector("#profile-bio")?.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("500 characters");
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("offers an accessible avatar upload action without an image URL field", async () => {
    await render();
    expect(container.querySelector('img[alt="Profile photo preview"]')?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button("Change profile photo").contains(container.querySelector("img"))).toBe(true);
    expect(button("Remove photo")).toBeDefined();
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(container.textContent).not.toContain("Use image URL");
    expect(button("Save profile").disabled).toBe(true);
  });

  it("saves a trimmed name only on Save, preserving an existing photo", async () => {
    const onDone = vi.fn();
    await render(onDone);
    await type("profile-display-name", "  Avery Example  ");
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledExactlyOnceWith({
      fullName: "Avery Example", avatarUrl: mocks.profile.avatarUrl, bio: null
    });
    expect(onDone).toHaveBeenCalledOnce();
    expect(mocks.showStatus).toHaveBeenCalledWith("Profile updated.", "success", 2500);
  });

  it("discards name, bio and picture drafts together on Cancel", async () => {
    await render();
    await type("profile-display-name", "Another name");
    await type("profile-bio", "Unsaved bio");
    await click("Remove photo");
    await click("Cancel");
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")?.value).toBe("Alex Teammate");
    expect(container.querySelector<HTMLTextAreaElement>("#profile-bio")?.value).toBe("");
    expect(container.querySelector('img[alt="Profile photo preview"]')?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(button("Save profile").disabled).toBe(true);
  });

  it("removes a photo as an explicit null while preserving the display name", async () => {
    await render();
    await click("Remove photo");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("AT");
    expect(button("Upload profile photo")).toBeDefined();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledExactlyOnceWith({ fullName: "Alex Teammate", avatarUrl: null, bio: null });
  });

  it("preserves an uploaded photo when changing only the display name", async () => {
    mocks.profile.avatarUrl = "data:image/png;base64,cGhvdG8=";
    await render();
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button("Save profile").disabled).toBe(true);
    await type("profile-display-name", "Updated name");
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledWith({ fullName: "Updated name", avatarUrl: mocks.profile.avatarUrl, bio: null });
  });

  it("opens the native photo picker and previews a valid upload without showing encoded data", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const picker = vi.spyOn(input, "click");
    await click("Change profile photo");
    expect(picker).toHaveBeenCalledOnce();
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, "result", { value: "data:image/png;base64,bmV3" });
      this.dispatchEvent(new ProgressEvent("load"));
    });
    await chooseFile(new File(["new"], "photo.png", { type: "image/png" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,bmV3");
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledWith({ fullName: "Alex Teammate", avatarUrl: "data:image/png;base64,bmV3", bio: null });
  });

  it("announces invalid files and keeps the existing photo", async () => {
    await render();
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    await chooseFile(new File(["text"], "notes.txt", { type: "text/plain" }));
    expect(read).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Choose an image file.");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button("Save profile").disabled).toBe(true);
  });

  it("announces a failed image read and retains the current photo", async () => {
    await render();
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent("error"));
    });
    await chooseFile(new File(["bad"], "bad.png", { type: "image/png" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to read image.");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button("Save profile").disabled).toBe(true);
  });

  it("keeps changes available for retry when saving fails", async () => {
    mocks.updateProfile.mockResolvedValue({ success: false, error: "Please retry." });
    const onDone = vi.fn();
    await render(onDone);
    await type("profile-display-name", "New name");
    await click("Save profile");
    expect(mocks.showStatus).toHaveBeenCalledWith("Please retry.", "error", 4000);
    expect(onDone).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")?.value).toBe("New name");
    expect(button("Save profile").disabled).toBe(false);
  });

  it("shows profile-load failures with a retry action", async () => {
    mocks.error = "Unable to load your profile.";
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(mocks.error);
    await click("Retry loading profile");
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({ force: true });
  });

  it("does not invite editing while the initial profile is loading", async () => {
    mocks.loading = true;
    await render();
    expect(container.querySelector<HTMLInputElement>("#profile-display-name")?.disabled).toBe(true);
    expect(button("Save profile").disabled).toBe(true);
    expect(button("Change profile photo").disabled).toBe(true);
    expect(button("Remove photo").disabled).toBe(true);
  });

  it("uses a stable avatar color while changing the display name or removing a photo", async () => {
    await render();
    await click("Remove photo");
    const avatar = container.querySelector<HTMLElement>('[data-testid="profile-avatar-preview"]')!;
    const color = avatar.style.getPropertyValue("--human-avatar-background");
    expect(avatar.textContent).toBe("AT");
    await type("profile-display-name", "Jamie Example");
    expect(avatar.textContent).toBe("JE");
    expect(avatar.style.getPropertyValue("--human-avatar-background")).toBe(color);
    await type("profile-display-name", "");
    expect(avatar.textContent).toBe("");
    expect(avatar.querySelector("svg")).not.toBeNull();
    expect(avatar.style.getPropertyValue("--human-avatar-background")).toBe(color);
  });
});
