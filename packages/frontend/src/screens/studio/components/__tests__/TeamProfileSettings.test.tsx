// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamProfileSettings } from "../TeamProfileSettings";

const mocks = vi.hoisted(() => ({ update: vi.fn(), upload: vi.fn(), showStatus: vi.fn() }));
vi.mock("../../../../services/runtimeController/projects", () => ({ updateControllerOrganization: mocks.update }));
vi.mock("../../../../lib/supabaseStorage", () => ({ uploadOrgAvatar: mocks.upload }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => true }));
const organization = { id: "empty-team", slug: "empty", name: "Empty team", avatarUrl: "https://example.test/old.png" };

describe("team profile editing", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.update.mockReset().mockResolvedValue(true);
    mocks.upload.mockReset().mockResolvedValue("https://example.test/new.png");
    mocks.showStatus.mockReset();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:team-preview"); static revokeObjectURL = vi.fn(); });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(role: string | null = "owner") {
    await act(async () => root.render(<TeamProfileSettings organization={organization} role={role} />));
  }
  async function changeName() {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="team-profile-name"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed team");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  it.each(["owner", "admin"])("allows %s to rename a team without any project", async (role) => {
    const updated = vi.fn(); window.addEventListener("instafy:orgs-updated", updated);
    try {
      await render(role); await changeName(); await submit();
      expect(mocks.update).toHaveBeenCalledExactlyOnceWith("empty-team", { name: "Renamed team" });
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Team profile saved.");
      expect(updated).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("instafy:orgs-updated", updated); }
  });
  it("explains Builder access and preserves the picture while hiding edit actions", async () => {
    await render("builder");
    expect(container.querySelector('[data-testid="team-profile-role-hint"]')?.textContent).toContain("You're a Builder");
    expect(container.querySelector<HTMLInputElement>('[data-testid="team-profile-name"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="org-avatar-change"]')).toBeNull();
    expect(container.querySelector('[data-testid="org-avatar-remove"]')).toBeNull();
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')?.getAttribute("src")).toBe(organization.avatarUrl);
    await submit();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("does not report success when the controller declines a name update", async () => {
    mocks.update.mockResolvedValue(false);
    await render(); await changeName(); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
  it("falls back to team initials when an uploaded picture is unavailable", async () => {
    await render();
    await act(async () => container.querySelector('[data-testid="org-avatar-preview"] img')!.dispatchEvent(new Event("error")));
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')).toBeNull();
    expect(container.querySelector('[data-testid="org-avatar-preview"]')?.textContent).toBe("ET");
  });
  async function choosePhoto() {
    const file = new File(["image"], "team.png", { type: "image/png" });
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="org-avatar-file-input"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return file;
  }
  async function cancel() {
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
  }
  it("previews removal, preserves the saved image on failure, and restores it on Cancel", async () => {
    mocks.update.mockResolvedValue(false);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="org-avatar-remove"]')!.click());
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    await submit();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("empty-team", { avatarUrl: "" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
    await cancel();
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')?.getAttribute("src")).toBe(organization.avatarUrl);
  });
  it("saves picture, name and color together for the displayed team only after Save", async () => {
    await render(); await changeName(); await chooseColor("violet");
    const file = await choosePhoto();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')?.getAttribute("src")).toBe("blob:team-preview");
    await submit();
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith({ orgId: "empty-team", file });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("empty-team", { name: "Renamed team", accentColor: "violet", avatarUrl: "https://example.test/new.png" });
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')?.getAttribute("src")).toBe("https://example.test/new.png");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="team-profile-save"]')?.disabled).toBe(true);
  });
  it("cancels all identity drafts without writing and uses the latest saved identity on refresh", async () => {
    await render(); await changeName(); await chooseColor("teal"); await choosePhoto();
    await act(async () => root.render(<TeamProfileSettings organization={{ ...organization, avatarUrl: "https://example.test/elsewhere.png" }} role="owner" />));
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')?.getAttribute("src")).toBe("blob:team-preview");
    await cancel();
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('[data-testid="team-profile-name"]')?.value).toBe("Empty team");
    expect(container.querySelector('[data-testid="org-avatar-preview"] img')?.getAttribute("src")).toBe("https://example.test/elsewhere.png");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:team-preview");
  });
  it("retries a metadata failure without uploading the same picture twice", async () => {
    await render(); await choosePhoto(); mocks.update.mockResolvedValueOnce(false);
    await submit();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await submit();
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Team profile saved.");
  });
  it.each(["owner", "admin", "builder"])("lets %s start a space in the displayed empty team", async (role) => {
    const onCreateSpace = vi.fn();
    await act(async () => root.render(<TeamProfileSettings organization={organization} role={role} onCreateSpace={onCreateSpace} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="team-profile-create-space"]')!.click());
    expect(onCreateSpace).toHaveBeenCalledExactlyOnceWith("empty-team");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["viewer", null])("keeps space creation unavailable without a writable team role: %s", async (role) => {
    await act(async () => root.render(<TeamProfileSettings organization={organization} role={role} onCreateSpace={vi.fn()} />));
    expect(container.querySelector('[data-testid="team-profile-create-space"]')).toBeNull();
  });
  it("updates a pristine name on refresh without discarding an unfinished edit", async () => {
    await render();
    await act(async () => root.render(<TeamProfileSettings organization={{ ...organization, name: "Updated elsewhere" }} role="owner" />));
    expect(container.querySelector<HTMLInputElement>('[data-testid="team-profile-name"]')?.value).toBe("Updated elsewhere");
    await changeName();
    await act(async () => root.render(<TeamProfileSettings organization={{ ...organization, name: "Another update" }} role="owner" />));
    expect(container.querySelector<HTMLInputElement>('[data-testid="team-profile-name"]')?.value).toBe("Renamed team");
  });
  async function chooseColor(color: string) {
    await act(async () => container.querySelector<HTMLInputElement>(`input[type="radio"][value="${color}"]`)!.click());
  }
  it("previews a color immediately and saves only the changed identity fields", async () => {
    await render(); await chooseColor("violet");
    expect(container.querySelector('[data-testid="org-avatar-preview"] [data-org-accent]')?.getAttribute("data-org-accent")).toBe("violet");
    expect(mocks.update).not.toHaveBeenCalled();
    await submit();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("empty-team", { accentColor: "violet" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Team profile saved.");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="team-profile-save"]')?.disabled).toBe(true);
  });
  it("retains unsaved color on a picture/name refresh and clears it on an org switch", async () => {
    await render(); await chooseColor("teal");
    await act(async () => root.render(<TeamProfileSettings organization={{ ...organization, accentColor: "pink" }} role="owner" />));
    expect(container.querySelector<HTMLInputElement>('input[value="teal"]')?.checked).toBe(true);
    await act(async () => root.render(<TeamProfileSettings organization={{ ...organization, id: "other", accentColor: "orange" }} role="owner" />));
    expect(container.querySelector<HTMLInputElement>('input[value="orange"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="team-profile-save"]')?.disabled).toBe(true);
  });
  it("refreshes a pristine color without losing a dirty name", async () => {
    await render(); await changeName();
    await act(async () => root.render(<TeamProfileSettings organization={{ ...organization, accentColor: "green" }} role="owner" />));
    expect(container.querySelector<HTMLInputElement>('input[value="green"]')?.checked).toBe(true);
    await submit();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("empty-team", { name: "Renamed team" });
  });
  it("keeps failed color edits retryable and prevents non-admin color changes", async () => {
    await render("viewer");
    expect(container.querySelector<HTMLFieldSetElement>('[data-testid="team-accent-picker"]')?.disabled).toBe(true);
    await render("owner"); await chooseColor("blue");
    mocks.update.mockResolvedValueOnce(false);
    await submit();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[value="blue"]')?.checked).toBe(true);
    await submit();
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

});
