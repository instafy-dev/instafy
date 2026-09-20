// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLauncher } from "../ProjectLauncher";
import { chooseSelectValue, readSelectValue } from "../../../../test-utils/select";

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), upload: vi.fn(), update: vi.fn(), showStatus: vi.fn(), reset: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { organizations: { list: mocks.list, create: mocks.create } } }));
vi.mock("../../../../lib/supabaseStorage", () => ({ uploadOrgAvatar: mocks.upload }));
vi.mock("../../../../services/runtimeController/projects", () => ({ updateControllerOrganization: mocks.update }));
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
});
