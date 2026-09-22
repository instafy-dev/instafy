// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalBrowserSharing, LocalBrowserTabPublisher } from "../LocalBrowserSharing";
import { browserShareClient, publishLocalBrowserTab } from "../../../../services/runtimeController/browserShares";
vi.mock("../../../../services/runtimeController/browserShares", () => ({ browserShareClient: vi.fn(), publishLocalBrowserTab: vi.fn() }));
vi.mock("../../../../components/Button", () => ({ Button: ({ onPress, children, isDisabled, ...props }: { onPress: () => void; children: React.ReactNode; isDisabled?: boolean; size?: string; variant?: string }) => { const attributes = { ...props }; delete attributes.size; delete attributes.variant; return <button {...attributes} disabled={isDisabled} onClick={onPress}>{children}</button>; } }));
let container: HTMLDivElement; let root: Root;
const share = { id: "share", projectId: "project", ownerUserId: "owner", audience: "space", mode: "view" };
let socket: EventTarget;
const people = [{ userId: "alice", fullName: "Alice", email: "alice@example.test" }, { userId: "bob", fullName: "Bob", email: "bob@example.test" }];
let removeViewer: ReturnType<typeof vi.fn>;
let viewers: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.useFakeTimers();
  socket = new EventTarget();
  removeViewer = vi.fn().mockResolvedValue(undefined);
  viewers = vi.fn().mockResolvedValue(people.map(person => ({ ...person, active: true, removed: false })));
  vi.mocked(browserShareClient).mockResolvedValue({ list: vi.fn().mockResolvedValue([share]), connect: vi.fn().mockResolvedValue(socket), people: vi.fn().mockResolvedValue({ people, hasMore: false }), viewers, removeViewer } as never);
  vi.mocked(publishLocalBrowserTab).mockImplementation(async (_p, _o, signal, ended, audience) => { signal.addEventListener("abort", () => ended()); return { ...share, audience: audience!.audience, mode: "view" }; });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:frame"), revokeObjectURL: vi.fn() }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = (canShare: boolean, userId = "viewer") => act(async () => root.render(<><LocalBrowserTabPublisher projectId="project" userId={userId} ownerId="binding" canShare={canShare} /><LocalBrowserSharing projectId="project" userId={userId} /></>));
const click = (id: string) => act(async () => (container.querySelector(`[data-testid=${id}]`) as HTMLElement).click());

it("defaults to selected people and never captures until a nonempty audience is confirmed", async () => {
  await render(true, "owner");
  expect(publishLocalBrowserTab).not.toHaveBeenCalled();
  await click("local-browser-share-start");
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe("selected");
  expect((container.querySelector('[data-testid="local-browser-share-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  expect(publishLocalBrowserTab).not.toHaveBeenCalled();
  await click("local-browser-share-confirm");
  expect(publishLocalBrowserTab).toHaveBeenCalledWith("project", "binding", expect.any(AbortSignal), expect.any(Function), { audience: "selected", viewerUserIds: ["alice"] }, expect.any(Function), expect.any(Function));
  expect(container.textContent).toContain("Sharing · Selected people · View only");
  const audience = container.querySelector('[data-testid="local-browser-share-audience"]')!;
  expect(audience.parentElement!.hidden).toBe(true);
  await click("local-browser-share-people"); expect(audience.parentElement!.hidden).toBe(false);
  await click("local-browser-share-people"); expect(audience.parentElement!.hidden).toBe(true);
  expect(publishLocalBrowserTab).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(publishLocalBrowserTab).mock.calls[0][2];
  expect(signal.aborted).toBe(false);
  await render(false, "owner"); expect(signal.aborted).toBe(true);
});

it("requires an explicit choice for space-wide sharing and removes one viewer without stopping others", async () => {
  await render(true, "owner"); await click("local-browser-share-start");
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = "space"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("local-browser-share-confirm");
  expect(publishLocalBrowserTab).toHaveBeenCalledWith("project", "binding", expect.any(AbortSignal), expect.any(Function), { audience: "space" }, expect.any(Function), expect.any(Function));
  expect(container.textContent).toContain("Sharing · Everyone in this space · View only");
  await click("local-browser-share-people");
  await act(async () => (container.querySelector('[aria-label="Remove Alice"]') as HTMLElement).click());
  expect(removeViewer).toHaveBeenCalledWith("share", "alice");
  expect(container.textContent).toContain("Alice · Removed from this share");
  expect(container.textContent).toContain("Bob · Viewing");
  // A stale audience poll must not undo an acknowledged removal.
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.querySelector('[aria-label="Remove Alice"]')).toBeNull();
  expect(vi.mocked(publishLocalBrowserTab).mock.calls[0][2].aborted).toBe(false);
});

it("shows failed removal without falsely claiming that access ended", async () => {
  removeViewer.mockRejectedValue(new Error("offline"));
  await render(true, "owner"); await click("local-browser-share-start");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await click("local-browser-share-confirm");
  await click("local-browser-share-people");
  await act(async () => (container.querySelector('[aria-label="Remove Alice"]') as HTMLElement).click());
  expect(container.textContent).toContain("Could not remove this person");
  expect(container.textContent).toContain("Alice · Viewing");
  expect(container.querySelector('[aria-label="Remove Alice"]')).not.toBeNull();
});

it("lets the owner watch from another device and removes pixels immediately on stream closure", async () => {
  await render(false, "owner"); await click("local-browser-share-join");
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([255,216,255,217]).buffer })));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:frame");
  await act(async () => socket.dispatchEvent(new Event("close")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("Connection closed");
  expect(container.querySelector('[data-testid="local-browser-share-join"]')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame");
});


it("uses one audience fetch for People and control/Explore labels, and stops polling with the share", async () => {
  vi.mocked(publishLocalBrowserTab).mockImplementation(async (_p, _o, signal, ended, audience) => {
    signal.addEventListener("abort", () => ended());
    return {
      ...share, audience: audience.audience, mode: "view",
      control: { grant: vi.fn().mockResolvedValue(undefined), revoke: vi.fn().mockResolvedValue(undefined), deny: vi.fn() },
      explore: { approve: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), deny: vi.fn() },
    };
  });
  await render(true, "owner");
  await click("local-browser-share-start");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("local-browser-share-confirm");
  expect(viewers).toHaveBeenCalledTimes(1);

  const publication = vi.mocked(publishLocalBrowserTab).mock.calls[0];
  await act(async () => publication[5]!({
    type: "controlState", available: true, connectionId: "owner", requested: false, grant: null,
    requests: [{ connectionId: "alice-tab", userId: "alice" }],
  }));
  expect(container.textContent).toContain("Alice requests control");
  expect(viewers).toHaveBeenCalledTimes(2);
  await click("local-browser-share-people");
  expect(container.textContent).toContain("Alice · Viewing");
  expect(viewers).toHaveBeenCalledTimes(2);

  await act(async () => publication[6]!({
    type: "exploreState", available: true, requested: false, view: null,
    requests: [{ connectionId: "bob-tab", userId: "bob", viewport: { width: 390, height: 650, dpr: 2 } }],
    views: [],
  }));
  expect(container.textContent).toContain("Bob wants to explore independently");
  expect(viewers).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(viewers).toHaveBeenCalledTimes(4);
  await click("local-browser-share-stop");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(viewers).toHaveBeenCalledTimes(4);
});
