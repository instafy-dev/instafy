// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileEditor } from "../ProfileEditor";

const mocks = vi.hoisted(() => ({
  user: { id: "profile-user", email: "teammate@example.test" } as { id: string; email: string } | null,
  profile: { fullName: "Alex Teammate", avatarUrl: "https://example.test/photo.png" } as {
    fullName: string | null;
    avatarUrl: string | null;
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
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
    expect(found, label).toBeDefined();
    return found!;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  async function type(id: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
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

  it("shows photo actions without exposing its stored URL, and reveals an accessible optional URL field", async () => {
    await render();
    expect(container.querySelector('img[alt="Profile photo preview"]')?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button("Change photo")).toBeDefined();
    expect(button("Remove photo")).toBeDefined();
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(button("Use image URL").getAttribute("aria-expanded")).toBe("false");
    expect(button("Save profile").disabled).toBe(true);

    await click("Use image URL");
    const disclosure = button("Hide image URL");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).not.toBeNull();
    expect(container.querySelector('label[for="profile-avatar-url"]')?.textContent).toBe("Image URL");
    expect(container.querySelector<HTMLInputElement>("#profile-avatar-url")?.value).toBe(mocks.profile.avatarUrl);
    expect(button("Save profile").disabled).toBe(true);
    await click("Hide image URL");
    expect(container.querySelector('input[type="url"]')).toBeNull();
  });

  it("saves a trimmed name and optional image link only on Save", async () => {
    const onDone = vi.fn();
    await render(onDone);
    await click("Use image URL");
    await type("profile-avatar-url", "https://example.test/replacement.png");
    await type("profile-display-name", "  Avery Example  ");
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Hide image URL");
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledExactlyOnceWith({
      fullName: "Avery Example", avatarUrl: "https://example.test/replacement.png"
    });
    expect(onDone).toHaveBeenCalledOnce();
    expect(mocks.showStatus).toHaveBeenCalledWith("Profile updated.", "success", 2500);
  });

  it("removes a photo as an explicit null while preserving the display name", async () => {
    await render();
    await click("Remove photo");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("AT");
    expect(button("Upload photo")).toBeDefined();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledExactlyOnceWith({ fullName: "Alex Teammate", avatarUrl: null });
  });

  it("does not expose uploaded image data when the optional URL field is opened", async () => {
    mocks.profile.avatarUrl = "data:image/png;base64,cGhvdG8=";
    await render();
    await click("Use image URL");
    expect(container.querySelector<HTMLInputElement>("#profile-avatar-url")?.value).toBe("");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(mocks.profile.avatarUrl);
    expect(button("Save profile").disabled).toBe(true);
    await type("profile-display-name", "Updated name");
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledWith({ fullName: "Updated name", avatarUrl: mocks.profile.avatarUrl });
  });

  it("opens the native photo picker and previews a valid upload without showing encoded data", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const picker = vi.spyOn(input, "click");
    await click("Change photo");
    expect(picker).toHaveBeenCalledOnce();
    await click("Use image URL");
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, "result", { value: "data:image/png;base64,bmV3" });
      this.dispatchEvent(new ProgressEvent("load"));
    });
    await chooseFile(new File(["new"], "photo.png", { type: "image/png" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,bmV3");
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    await click("Save profile");
    expect(mocks.updateProfile).toHaveBeenCalledWith({ fullName: "Alex Teammate", avatarUrl: "data:image/png;base64,bmV3" });
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
