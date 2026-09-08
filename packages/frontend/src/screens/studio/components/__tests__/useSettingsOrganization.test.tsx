// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsOrganization } from "../useSettingsOrganization";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../services/runtimeController/projects", () => ({ listControllerOrganizations: mocks.list }));
const teams = [
  { id: "project-team", name: "Project team", slug: "project", role: "builder" },
  { id: "empty-team", name: "Empty team", slug: "empty", role: "owner" },
];

describe("settings organization scope", () => {
  let root: Root;
  let container: HTMLDivElement;
  let scope: ReturnType<typeof useSettingsOrganization>;
  function Probe(props: Partial<Parameters<typeof useSettingsOrganization>[0]>) {
    scope = useSettingsOrganization({ enabled: true, userId: "user-a", projectOrganizationId: "project-team", selectOrganization: true, ...props });
    return <div>{scope.selectedId}:{scope.role}</div>;
  }
  const render = async (props: Partial<Parameters<typeof useSettingsOrganization>[0]> = {}) => {
    await act(async () => root.render(<Probe {...props} />));
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.list.mockReset().mockResolvedValue(teams);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("loads an explicitly selected empty team without a project", async () => {
    await render({ organizationId: "empty-team", projectOrganizationId: null });
    expect(scope!.organization).toEqual(teams[1]);
    expect(scope!.role).toBe("owner");
    expect(scope!.organizations).toHaveLength(2);
  });

  it("selects empty teams locally but keeps space settings scoped to the active project's team", async () => {
    await render();
    await act(async () => scope!.select("empty-team"));
    expect(scope!.selectedId).toBe("empty-team");
    expect(scope!.role).toBe("owner");
    await render({ selectOrganization: false, organizationId: "empty-team" });
    expect(scope!.selectedId).toBe("project-team");
    expect(scope!.role).toBe("builder");
  });

  it("updates scope immediately when the requested organization changes", async () => {
    await render({ organizationId: "empty-team" });
    expect(scope!.role).toBe("owner");
    await render({ organizationId: "project-team" });
    expect(scope!.role).toBe("builder");
    await render({ organizationId: "unknown-team" });
    expect(scope!.organization).toBeNull();
    expect(scope!.role).toBeNull();
  });

  it("does not revive an old local choice when Back restores its previous URL target", async () => {
    await render({ organizationId: "project-team" });
    await act(async () => scope!.select("empty-team"));
    expect(scope!.selectedId).toBe("empty-team");
    // The parent persists the selector choice to the URL, then browser Back restores A.
    await render({ organizationId: "empty-team" });
    expect(scope!.selectedId).toBe("empty-team");
    await render({ organizationId: "project-team" });
    expect(scope!.selectedId).toBe("project-team");
    expect(scope!.role).toBe("builder");
  });

  it("does not carry a previous account's ownership into an account change", async () => {
    await render({ organizationId: "empty-team" });
    let resolve!: (value: typeof teams) => void;
    mocks.list.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    await render({ organizationId: "empty-team", userId: "user-b" });
    expect(scope!.organizations).toEqual([]);
    expect(scope!.role).toBeNull();
    await act(async () => resolve([{ ...teams[1], role: "viewer" }]));
    expect(scope!.role).toBe("viewer");
  });

  it("shows a retryable failure and removes edit authority until refresh succeeds", async () => {
    await render({ organizationId: "empty-team" });
    mocks.list.mockRejectedValueOnce(new Error("offline"));
    await act(async () => window.dispatchEvent(new Event("instafy:orgs-updated")));
    expect(scope!.error).toBe("Couldn't load teams. Try again.");
    expect(scope!.role).toBeNull();
    expect(scope!.organization?.name).toBe("Empty team");
    await act(async () => scope!.refresh());
    expect(scope!.error).toBeNull();
    expect(scope!.role).toBe("owner");
  });

  it("ignores an older request after a newer refresh has completed", async () => {
    let resolve!: (value: typeof teams) => void;
    mocks.list.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    await render({ organizationId: "empty-team" });
    await act(async () => scope!.refresh());
    expect(scope!.role).toBe("owner");
    await act(async () => resolve([{ ...teams[1], role: "viewer" }]));
    expect(scope!.role).toBe("owner");
  });
});
