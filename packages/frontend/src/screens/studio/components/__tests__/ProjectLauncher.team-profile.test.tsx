// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLauncher } from "../ProjectLauncher";
import { Button } from "../../../../components/Button";
import { chooseSelectValue, isSelectDisabled, readSelectOptions, readSelectValue } from "../../../../test-utils/select";

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), upload: vi.fn(), update: vi.fn(), showStatus: vi.fn(), reset: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { organizations: { list: mocks.list, create: mocks.create } } }));
vi.mock("../../../../lib/supabaseStorage", () => ({ uploadOrgAvatar: mocks.upload }));
vi.mock("../../../../services/runtimeController/projects", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../services/runtimeController/projects")>(),
  updateControllerOrganization: mocks.update,
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../device-auth/useDeviceAuthFlow", () => ({ useDeviceAuthFlow: () => ({ reset: mocks.reset }) }));
vi.mock("../../../../components/aria/StudioModal", () => ({ StudioDialogModal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div> }));

describe("space launcher team creation", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.list.mockReset().mockResolvedValue([{ id: "existing-team", name: "Existing", slug: "existing" }]);
    mocks.create.mockReset().mockResolvedValue({ id: "created-team", name: "Photo team", slug: "photo" });
    mocks.upload.mockReset().mockResolvedValue("https://example.test/photo.png");
    mocks.update.mockReset().mockResolvedValue(true);
    URL.createObjectURL = vi.fn().mockReturnValue("blob:preview"); URL.revokeObjectURL = vi.fn();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function input(id: string, value: string) {
    await act(async () => {
      const element = container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("uses the same optional picture flow and creates the first space in that saved team", async () => {
    const onCreateBlank = vi.fn(); const onClose = vi.fn();
    await act(async () => root.render(<ProjectLauncher open onClose={onClose} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />));
    await input("project-launcher-name-input", "First space");
    await chooseSelectValue(container.querySelector('[data-testid="project-launcher-org-select"]'), "new");
    await input("project-launcher-org-name-input", "Photo team");
    await act(async () => {
      const picker = container.querySelector<HTMLInputElement>('[data-testid="new-team-picture-input"]')!;
      Object.defineProperty(picker, "files", { value: [new File(["image"], "photo.png", { type: "image/png" })] });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => container.querySelectorAll("form")[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("created-team", { avatarUrl: "https://example.test/photo.png" });
    expect(readSelectValue(container.querySelector('[data-testid="project-launcher-org-select"]'))).toBe("created-team");
    expect(onCreateBlank).not.toHaveBeenCalled();
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreateBlank).toHaveBeenCalledExactlyOnceWith("First space", { orgId: "created-team" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("suggests the preferred team only where this person can add spaces to it", async () => {
    mocks.list.mockResolvedValue([
      { id: "build-team", name: "Build", slug: "build", role: "builder" },
      { id: "watch-team", name: "Watch", slug: "watch", role: "viewer" },
    ]);
    const select = () => container.querySelector('[data-testid="project-launcher-org-select"]');
    const launcher = (preferredOrgId: string) => (
      <ProjectLauncher open preferredOrgId={preferredOrgId} onClose={vi.fn()} onCreateBlank={vi.fn()} onCreateFromGithub={vi.fn()} />
    );
    // A phone's New space names the team on screen, whatever this person's role in it.
    await act(async () => root.render(launcher("watch-team")));
    await act(async () => {});
    expect(readSelectValue(select())).not.toBe("watch-team");
    await act(async () => root.render(launcher("build-team")));
    await act(async () => {});
    expect(readSelectValue(select())).toBe("build-team");
  });

  // A local test, Nov 8: the New space dialog opened on a disabled "Choose
  // team" that turned into "Personal (owner)" once the teams had loaded. A
  // space with no team chosen goes to the person's own team all along.
  it("reads Personal from the moment it opens, and lists the person's own team once", async () => {
    let teamsLoaded: (teams: unknown[]) => void = () => undefined;
    mocks.list.mockReturnValue(new Promise((resolve) => { teamsLoaded = resolve; }));
    const onCreateBlank = vi.fn();
    await act(async () => root.render(
      <ProjectLauncher open currentUserId="person-1" onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />,
    ));
    const select = () => container.querySelector('[data-testid="project-launcher-org-select"]');
    // While the teams load.
    expect(isSelectDisabled(select())).toBe(false);
    expect(select()?.textContent).toContain("Personal");
    expect(container.textContent).not.toContain("Choose team");
    await act(async () => teamsLoaded([
      { id: "own-team", name: "Personal team", slug: "user-person-1", role: "owner" },
      { id: "photo-team", name: "Photo team", slug: "photo", role: "builder" },
    ]));
    expect(select()?.textContent).toContain("Personal");
    expect(await readSelectOptions(select())).toEqual(["Personal", "Photo team (builder)", "+ Create new team"]);
    await input("project-launcher-name-input", "Lisbon trip");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreateBlank).toHaveBeenCalledExactlyOnceWith("Lisbon trip", { orgId: "own-team" });
  });

  describe("while the teams load", () => {
    const own = { id: "own-team", name: "Personal team", slug: "user-person-1", role: "owner" };
    const photo = { id: "photo-team", name: "Photo team", slug: "photo", role: "builder" };
    const watch = { id: "watch-team", name: "Watch", slug: "watch", role: "viewer" };
    const select = () => container.querySelector('[data-testid="project-launcher-org-select"]');
    const shown = () => select()?.textContent ?? "";
    /** The team list, answered when the test says. */
    function teamsLater() {
      let answer: (teams: unknown[]) => void = () => undefined;
      mocks.list.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
      return (teams: unknown[]) => act(async () => answer(teams));
    }
    async function create(onCreateBlank: ReturnType<typeof vi.fn>) {
      await input("project-launcher-name-input", "Lisbon trip");
      await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      return onCreateBlank.mock.calls.at(-1);
    }

    it("keeps a team made before they came, shown and chosen", async () => {
      const loaded = teamsLater();
      const onCreateBlank = vi.fn();
      await act(async () => root.render(
        <ProjectLauncher open currentUserId="person-1" onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />,
      ));
      await chooseSelectValue(select(), "new");
      await input("project-launcher-org-name-input", "Photo team");
      await act(async () => container.querySelectorAll("form")[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      // The list was read before that team existed.
      await loaded([own]);
      expect(shown()).toBe("Photo team");
      expect(await readSelectOptions(select())).toEqual(["Personal", "Photo team", "+ Create new team"]);
      expect(await create(onCreateBlank)).toEqual(["Lisbon trip", { orgId: "created-team" }]);
    });

    it("offers no team from the last time it opened until they come", async () => {
      mocks.list.mockResolvedValueOnce([own, photo]);
      const onCreateBlank = vi.fn();
      const launcher = (open: boolean) => (
        <ProjectLauncher open={open} currentUserId="person-1" onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />
      );
      await act(async () => root.render(launcher(true)));
      await act(async () => root.render(launcher(false)));
      // The person left Photo team since.
      const loaded = teamsLater();
      await act(async () => root.render(launcher(true)));
      expect(await readSelectOptions(select())).toEqual(["Personal", "+ Create new team"]);
      await loaded([own]);
      expect(shown()).toBe("Personal");
      expect(await create(onCreateBlank)).toEqual(["Lisbon trip", { orgId: "own-team" }]);
    });

    it("reads the team on screen from the start, by the name Studio shows for it", async () => {
      const loaded = teamsLater();
      const onCreateBlank = vi.fn();
      await act(async () => root.render(
        <ProjectLauncher open preferredOrgId="photo-team" preferredOrgName="Photo team" currentUserId="person-1"
          onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />,
      ));
      expect(shown()).toBe("Photo team");
      expect(readSelectValue(select())).toBe("photo-team");
      await loaded([own, photo]);
      expect(shown()).toBe("Photo team (builder)");
      expect(await readSelectOptions(select())).toEqual(["Personal", "Photo team (builder)", "+ Create new team"]);
      expect(await create(onCreateBlank)).toEqual(["Lisbon trip", { orgId: "photo-team" }]);
    });

    it("turns to Personal once they show the person can't add spaces to the team on screen", async () => {
      const loaded = teamsLater();
      const onCreateBlank = vi.fn();
      await act(async () => root.render(
        <ProjectLauncher open preferredOrgId="watch-team" preferredOrgName="Watch" currentUserId="person-1"
          onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />,
      ));
      expect(shown()).toBe("Watch");
      await loaded([own, watch]);
      expect(shown()).toBe("Personal");
      expect(await create(onCreateBlank)).toEqual(["Lisbon trip", { orgId: "own-team" }]);
    });

    it("keeps Personal when the person chose it before they came", async () => {
      const loaded = teamsLater();
      const onCreateBlank = vi.fn();
      await act(async () => root.render(
        <ProjectLauncher open preferredOrgId="photo-team" preferredOrgName="Photo team" currentUserId="person-1"
          onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />,
      ));
      await chooseSelectValue(select(), "");
      await loaded([own, photo]);
      expect(shown()).toBe("Personal");
      expect(await create(onCreateBlank)).toEqual(["Lisbon trip", { orgId: "own-team" }]);
    });
  });

  // Their own team keeps the name they gave it, as Home and the team list show it.
  it("names the person's own team as they named it", async () => {
    mocks.list.mockResolvedValue([
      { id: "own-team", name: "Alex's studio", slug: "user-person-1", role: "owner" },
      { id: "photo-team", name: "Photo team", slug: "photo", role: "builder" },
    ]);
    const onCreateBlank = vi.fn();
    await act(async () => root.render(
      <ProjectLauncher open currentUserId="person-1" onClose={vi.fn()} onCreateBlank={onCreateBlank} onCreateFromGithub={vi.fn()} />,
    ));
    const select = () => container.querySelector('[data-testid="project-launcher-org-select"]');
    expect(select()?.textContent).toBe("Alex's studio");
    expect(await readSelectOptions(select())).toEqual(["Alex's studio", "Photo team (builder)", "+ Create new team"]);
    await input("project-launcher-name-input", "Lisbon trip");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreateBlank).toHaveBeenCalledExactlyOnceWith("Lisbon trip", { orgId: "own-team" });
  });

  it("gives Create a new space and New team the same Cancel as Studio's other dialogs", async () => {
    await act(async () => root.render(<ProjectLauncher open onClose={vi.fn()} onCreateBlank={vi.fn()} onCreateFromGithub={vi.fn()} />));
    await chooseSelectValue(container.querySelector('[data-testid="project-launcher-org-select"]'), "new");
    const cancels = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Cancel");
    expect(cancels).toHaveLength(2);
    // The quiet form action the Stop and Take over confirmations use.
    const reference = document.createElement("div");
    const referenceRoot = createRoot(reference);
    await act(async () => referenceRoot.render(<Button variant="ghost" preset="form">Cancel</Button>));
    const quiet = reference.querySelector("button")!.className;
    await act(async () => referenceRoot.unmount());
    for (const cancel of cancels) expect(cancel.className).toBe(quiet);
  });
});
