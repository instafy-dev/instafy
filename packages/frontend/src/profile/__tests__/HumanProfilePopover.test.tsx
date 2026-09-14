// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerHumanProfile } from "@instafy/sdk/human-profiles";
import { HumanProfilePopover } from "../HumanProfilePopover";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  desktop: true,
  viewerId: "viewer-1" as string | null,
  token: "viewer-token" as string | null,
}));
vi.mock("../humanProfileService", () => ({ fetchHumanProfile: mocks.fetch }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({
  user: mocks.viewerId ? { id: mocks.viewerId } : null,
  session: mocks.token ? { access_token: mocks.token } : null,
}) }));
vi.mock("../../hooks/useBreakpoint", () => ({ useBreakpoint: () => mocks.desktop }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const profile: ControllerHumanProfile = {
  userId: "person-1", displayName: "Alex Teammate", avatarUrl: "https://example.test/alex.png",
  bio: "I build helpful tools.\n<script>not executable</script>",
};

describe("HumanProfilePopover", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    mocks.viewerId = "viewer-1"; mocks.token = "viewer-token"; mocks.desktop = true;
    mocks.fetch.mockReset().mockResolvedValue(profile);
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    await nextFrame();
    container.remove(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function nextFrame() {
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  async function render(projectId: string | null = "space-1", userId: string | null = "person-1") {
    await act(async () => root.render(<HumanProfilePopover projectId={projectId} userId={userId} displayName="Old roster name">
      <span>Old roster name</span>
    </HumanProfilePopover>));
  }
  async function open() {
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { trigger.focus(); trigger.click(); });
    return trigger;
  }
  function card() { return document.querySelector<HTMLElement>("[data-human-profile-card]"); }
  async function close() {
    await act(async () => card()!.querySelector<HTMLButtonElement>('[aria-label="Close profile"]')!.click());
  }

  it("loads on demand in the exact space and shows only saved public content as plain text", async () => {
    const response = deferred<ControllerHumanProfile>();
    mocks.fetch.mockReturnValueOnce(response.promise);
    await render();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await open();
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe("Loading profile…");
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith({ projectId: "space-1", userId: "person-1", accessToken: "viewer-token", signal: expect.any(AbortSignal) });
    await act(async () => response.resolve(profile));
    expect(card()?.textContent).toContain("Alex Teammate");
    expect(card()?.textContent).not.toContain("Old roster name");
    expect(card()?.textContent).toContain("<script>not executable</script>");
    expect(card()?.querySelector("script")).toBeNull();
    expect(card()?.querySelector("img")?.getAttribute("src")).toBe(profile.avatarUrl);
    await close();
    expect(card()).toBeNull();
  });

  it("respects explicitly cleared name, photo and introduction without restoring roster values", async () => {
    mocks.fetch.mockResolvedValueOnce({ userId: "person-1", displayName: null, avatarUrl: null, bio: null });
    await render(); await open();
    expect(card()?.textContent).toContain("Teammate");
    expect(card()?.textContent).toContain("No introduction yet.");
    expect(card()?.textContent).not.toContain("Old roster name");
    expect(card()?.querySelector("img")).toBeNull();
  });

  it("shows a recoverable access failure and retries with current authentication", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("403 denied"));
    await render(); await open();
    expect(card()?.querySelector('[role="alert"]')?.textContent).toContain("Access to this space may have changed");
    expect(card()?.textContent).not.toContain("No introduction yet.");
    const retry = Array.from(card()!.querySelectorAll("button")).find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(card()?.textContent).toContain("Alex Teammate");
    expect(card()?.querySelector('[role="alert"]')).toBeNull();
  });

  it("cancels closed and changed-space requests and ignores their late content", async () => {
    const late = deferred<ControllerHumanProfile>();
    mocks.fetch.mockReturnValueOnce(late.promise);
    await render(); await open();
    const firstSignal = mocks.fetch.mock.calls[0][0].signal as AbortSignal;
    await close();
    expect(firstSignal.aborted).toBe(true);
    await act(async () => late.resolve({ ...profile, displayName: "Obsolete" }));
    expect(card()).toBeNull();
    await open();
    const nextSignal = mocks.fetch.mock.calls[1][0].signal as AbortSignal;
    expect(card()?.textContent).toContain("Alex Teammate");
    await render("space-2");
    expect(card()).toBeNull();
    expect(nextSignal.aborted).toBe(true);
    await open();
    expect(mocks.fetch.mock.lastCall?.[0].projectId).toBe("space-2");
    expect(card()?.textContent).not.toContain("Obsolete");
  });

  it("clears old account content immediately and ignores an old account's late response", async () => {
    const old = deferred<ControllerHumanProfile>();
    const next = deferred<ControllerHumanProfile>();
    mocks.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await render(); await open();
    const oldSignal = mocks.fetch.mock.calls[0][0].signal as AbortSignal;
    mocks.viewerId = "viewer-2"; mocks.token = "next-token";
    await render();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => old.resolve({ ...profile, bio: "Only the old account could see this" }));
    expect(card()?.textContent).not.toContain("Only the old account could see this");
    expect(card()?.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => next.resolve({ ...profile, bio: "Current account response" }));
    expect(card()?.textContent).toContain("Current account response");
  });

  it("offers no directory entry without both a current space and identified person", async () => {
    await render(null);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("Old roster name");
    await render("space-1", null);
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses a dismissable compact mobile dialog and restores focus to the person", async () => {
    mocks.desktop = false;
    await render();
    const trigger = await open();
    const dialog = document.querySelector('[role="dialog"][aria-label="Person profile"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('[role="dialog"]')?.textContent).toContain("Alex Teammate");
    await act(async () => card()!.querySelector<HTMLButtonElement>('[aria-label="Close profile"]')!.focus());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(card()).toBeNull();
    await nextFrame();
    expect(document.activeElement).toBe(trigger);
  });
});
