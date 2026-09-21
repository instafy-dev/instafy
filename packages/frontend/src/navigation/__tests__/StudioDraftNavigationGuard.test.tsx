// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDraftsProvider, useStudioDraftState, useStudioNavigationProtection } from "../../workspace/StudioDrafts";
import { StudioDraftNavigationGuard, useStudioGuardedNavigation } from "../StudioDraftNavigationGuard";

vi.mock("../../components/aria/StudioModal", () => ({
  StudioDialogModal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div role="dialog">{children}</div> : null,
}));

describe("Studio draft navigation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let router: ReturnType<typeof createMemoryRouter>;
  let busy = false;
  const discarded = vi.fn();
  let edit: (value: string) => void;
  let startFlow: () => void;
  let guarded: (action: () => void) => void;
  let finish: () => void;

  function Editor() {
    const [name, setName] = useStudioDraftState("profile:user:name", "Alex");
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(busy);
    edit = setName;
    startFlow = () => setOpen(true);
    finish = () => { setPending(false); setOpen(false); };
    useStudioNavigationProtection(open, "agent editor", pending ? undefined : () => { discarded(); setOpen(false); });
    return <output>{name}</output>;
  }
  function Page() {
    guarded = useStudioGuardedNavigation();
    const location = useLocation();
    return location.search.includes("settings") ? <Editor /> : <p>Other page</p>;
  }
  function App() {
    return <StudioDraftsProvider><StudioDraftNavigationGuard><Page /></StudioDraftNavigationGuard></StudioDraftsProvider>;
  }
  const navigate = (to: string | number) => act(async () => {
    if (typeof to === "number") await router.navigate(to);
    else await router.navigate(to);
  });
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const dialog = () => container.querySelector('[role="dialog"]');
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    busy = false;
    discarded.mockClear();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    router = createMemoryRouter([{ path: "*", element: <App /> }], { initialEntries: ["/studio?panel=settings"] });
    await act(async () => root.render(<RouterProvider router={router} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); router.dispose(); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retains ordinary edits across panels and Back/Forward without a dialog", async () => {
    await act(async () => edit("Unfinished name"));
    await navigate("/studio?panel=credits");
    expect(dialog()).toBeNull();
    await navigate(-1);
    expect(container.querySelector("output")?.textContent).toBe("Unfinished name");
    await navigate(1);
    expect(container.querySelector("output")).toBeNull();
    await navigate(-1);
    expect(container.querySelector("output")?.textContent).toBe("Unfinished name");
  });

  it("guards leaving Studio and unload while edits exist, and clears them only on discard", async () => {
    await act(async () => edit("Unfinished name"));
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await navigate("/elsewhere");
    expect(router.state.location.pathname).toBe("/studio");
    await click("Keep editing");
    expect(container.querySelector("output")?.textContent).toBe("Unfinished name");
    await navigate("/elsewhere"); await click("Discard and leave");
    expect(router.state.location.pathname).toBe("/elsewhere");
    await navigate("/studio?panel=settings");
    expect(container.querySelector("output")?.textContent).toBe("Alex");
    const cleanUnload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("keeps complex editors mounted on Back until explicitly discarded", async () => {
    await navigate("/studio?panel=credits"); await navigate("/studio?panel=settings");
    await act(async () => startFlow());
    await navigate(-1);
    expect(dialog()).not.toBeNull();
    expect(container.querySelector("output")).not.toBeNull();
    await click("Keep editing"); expect(discarded).not.toHaveBeenCalled();
    await navigate(-1); await click("Discard and leave");
    expect(discarded).toHaveBeenCalledOnce();
    expect(router.state.location.search).toBe("?panel=credits");
    expect(dialog()).toBeNull();
  });

  it("runs an imperative tab continuation once without a second Router confirmation", async () => {
    await act(async () => startFlow());
    const action = vi.fn(() => { void router.navigate("/studio?panel=credits"); });
    await act(async () => guarded(action));
    expect(action).not.toHaveBeenCalled();
    await click("Discard and leave");
    expect(action).toHaveBeenCalledOnce();
    expect(discarded).toHaveBeenCalledOnce();
    expect(router.state.location.search).toBe("?panel=credits");
    expect(dialog()).toBeNull();
  });

  it("allows canonical URL hydration and opening a drawer without prompting or releasing the editor", async () => {
    await act(async () => startFlow());
    await navigate("/studio?panel=settings&conversationControllerId=resolved&workspaceTab=history");
    expect(dialog()).toBeNull();
    expect(discarded).not.toHaveBeenCalled();
    await navigate("/studio?panel=credits");
    expect(dialog()).not.toBeNull();
    await click("Keep editing");
    expect(router.state.location.search).toContain("panel=settings");
  });

  it("waits for in-flight work and then allows the pending destination", async () => {
    busy = true;
    await navigate("/studio?panel=credits"); await navigate("/studio?panel=settings");
    await act(async () => startFlow());
    await navigate("/studio?panel=credits");
    expect(dialog()?.textContent).toContain("Work is still in progress");
    expect(dialog()?.textContent).not.toContain("Discard and leave");
    await act(async () => finish());
    await click("Continue");
    expect(router.state.location.search).toBe("?panel=credits");
  });
});
