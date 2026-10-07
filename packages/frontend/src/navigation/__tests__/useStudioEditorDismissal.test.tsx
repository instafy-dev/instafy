// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDialogModal } from "../../components/aria/StudioModal";
import { useNativeBackButtonAction } from "../../native/useNativeBackButtonAction";
import { StudioDraftsProvider } from "../../workspace/StudioDrafts";
import { StudioDraftNavigationGuard } from "../StudioDraftNavigationGuard";
import { useStudioEditorDismissal } from "../useStudioEditorDismissal";

const native = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: native.listen } }));

describe("Studio editor dismissal", () => {
  let root: Root;
  let container: HTMLDivElement;
  let router: ReturnType<typeof createMemoryRouter>;
  let back: () => void;
  let changeDraft: (draft: string) => void;
  let changePending: (pending: boolean) => void;
  const drawerBack = vi.fn();
  const discarded = vi.fn();

  function Editor() {
    const [open, setOpen] = useState(true);
    const [draft, setDraft] = useState("");
    const [pending, setPending] = useState(false);
    changeDraft = setDraft;
    changePending = setPending;
    const dismiss = useStudioEditorDismissal({
      isOpen: open, isDirty: draft !== "", isPending: pending, label: "test editor",
      onDiscard: () => { discarded(); setOpen(false); setDraft(""); },
    });
    useNativeBackButtonAction(true, drawerBack, 10);
    return <StudioDialogModal isOpen={open} onOpenChange={open => { if (!open) dismiss(); }}
      isDismissable dialogAriaLabel="Edit draft">
      <input aria-label="Draft" value={draft} readOnly />
      <button onClick={dismiss}>Close editor</button>
      <button onClick={dismiss}>Cancel</button>
    </StudioDialogModal>;
  }
  const dialog = (label: string) => document.querySelector(`[role="dialog"][aria-label="${label}"]`);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.listen.mockImplementation(async (_event: string, listener: () => void) => {
      back = listener;
      return { remove: async () => {} };
    });
    drawerBack.mockReset();
    discarded.mockReset();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    router = createMemoryRouter([{ path: "*", element: <StudioDraftsProvider><StudioDraftNavigationGuard>
      <Editor />
    </StudioDraftNavigationGuard></StudioDraftsProvider> }], {
      initialEntries: ["/studio?panel=settings", "/studio?panel=skills"], initialIndex: 1,
    });
    await act(async () => root.render(<RouterProvider router={router} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); router.dispose(); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("closes an untouched modal before the drawer without navigating or warning", async () => {
    await act(async () => back());
    expect(dialog("Edit draft")).toBeNull();
    expect(dialog("Unfinished work")).toBeNull();
    expect(router.state.location.search).toBe("?panel=skills");
    expect(drawerBack).not.toHaveBeenCalled();
    await act(async () => back());
    expect(drawerBack).toHaveBeenCalledOnce();
  });

  it.each(["Android Back", "Escape", "Close editor", "Cancel"])("protects edits on %s and discards only the modal", async (action) => {
    await act(async () => changeDraft("An unsaved name"));
    const close = async () => {
      if (action === "Android Back") await act(async () => back());
      else if (action === "Escape") await act(async () => {
        dialog("Edit draft")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      else await click(action);
    };
    await close();
    expect(dialog("Unfinished work")).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Draft"]')?.value).toBe("An unsaved name");
    // The confirmation's higher priority must keep Back from closing the editor.
    await act(async () => back());
    expect(dialog("Unfinished work")).toBeNull();
    expect(dialog("Edit draft")).not.toBeNull();
    await close();
    await click("Discard and leave");
    expect(discarded).toHaveBeenCalledOnce();
    expect(dialog("Edit draft")).toBeNull();
    expect(router.state.location.search).toBe("?panel=skills");
    expect(drawerBack).not.toHaveBeenCalled();
  });

  it("consumes modal Back and close during a save even if the caller omitted the keyboard-disabled prop", async () => {
    await act(async () => { changeDraft("Saving this"); changePending(true); });
    await act(async () => back());
    await click("Cancel");
    expect(dialog("Edit draft")).not.toBeNull();
    expect(dialog("Unfinished work")).toBeNull();
    expect(drawerBack).not.toHaveBeenCalled();
    await act(async () => router.navigate(-1));
    expect(dialog("Unfinished work")?.textContent).toContain("Work is still in progress");
    expect(router.state.location.search).toBe("?panel=skills");
  });

  it("allows route navigation after edits are reverted without a false dirty warning", async () => {
    await act(async () => changeDraft("Changed"));
    await act(async () => changeDraft(""));
    await act(async () => router.navigate(-1));
    expect(dialog("Unfinished work")).toBeNull();
    expect(router.state.location.search).toBe("?panel=settings");
  });
});
