// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalBrowserSharing, LocalBrowserTabPublisher } from "../LocalBrowserSharing";
import { browserShareClient, publishLocalBrowserTab } from "../../../../services/runtimeController/browserShares";
vi.mock("../../../../services/runtimeController/browserShares", () => ({ browserShareClient: vi.fn(), publishLocalBrowserTab: vi.fn() }));
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
const click = (id: string) => act(async () => (document.querySelector(`[data-testid=${id}]`) as HTMLElement).click());

it("defaults to selected people and never captures until a nonempty audience is confirmed", async () => {
  await render(true, "owner");
  expect(publishLocalBrowserTab).not.toHaveBeenCalled();
  await click("local-browser-share-start");
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe("selected");
  expect((document.querySelector('[data-testid="local-browser-share-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  expect(publishLocalBrowserTab).not.toHaveBeenCalled();
  await click("local-browser-share-confirm");
  expect(publishLocalBrowserTab).toHaveBeenCalledWith("project", "binding", expect.any(AbortSignal), expect.any(Function), { audience: "selected", viewerUserIds: ["alice"] }, expect.any(Function), expect.any(Function));
  expect(document.querySelector('[data-testid="local-browser-share-people"]')?.textContent).toContain("Sharing");
  expect(document.querySelector('[data-testid="local-browser-share-audience"]')).toBeNull();
  await click("local-browser-share-people");
  expect(document.querySelector('[role="dialog"][aria-label="Sharing settings"]')?.textContent).toContain("Selected people");
  await click("local-browser-share-people");
  expect(document.querySelector('[data-testid="local-browser-share-audience"]')).toBeNull();
  expect(publishLocalBrowserTab).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(publishLocalBrowserTab).mock.calls[0][2];
  expect(signal.aborted).toBe(false);
  await render(false, "owner"); expect(signal.aborted).toBe(true);
});

it("requires an explicit choice for space-wide sharing and removes one viewer without stopping others", async () => {
  await render(true, "owner"); await click("local-browser-share-start");
  await act(async () => {
    const select = document.querySelector("select")!;
    select.value = "space"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("local-browser-share-confirm");
  expect(publishLocalBrowserTab).toHaveBeenCalledWith("project", "binding", expect.any(AbortSignal), expect.any(Function), { audience: "space" }, expect.any(Function), expect.any(Function));
  await click("local-browser-share-people");
  expect(document.body.textContent).toContain("Everyone in this space");
  await act(async () => (document.querySelector('[aria-label="Remove Alice"]') as HTMLElement).click());
  expect(removeViewer).toHaveBeenCalledWith("share", "alice");
  expect(document.body.textContent).toContain("Alice · Removed from this share");
  expect(document.body.textContent).toContain("Bob · Following");
  // A stale audience poll must not undo an acknowledged removal.
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(document.querySelector('[aria-label="Remove Alice"]')).toBeNull();
  expect(vi.mocked(publishLocalBrowserTab).mock.calls[0][2].aborted).toBe(false);
});

it("shows failed removal without falsely claiming that access ended", async () => {
  removeViewer.mockRejectedValue(new Error("offline"));
  await render(true, "owner"); await click("local-browser-share-start");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await click("local-browser-share-confirm");
  await click("local-browser-share-people");
  await act(async () => (document.querySelector('[aria-label="Remove Alice"]') as HTMLElement).click());
  expect(document.body.textContent).toContain("Could not remove this person");
  expect(document.body.textContent).toContain("Alice · Following");
  expect(document.querySelector('[aria-label="Remove Alice"]')).not.toBeNull();
});

it("lets the owner watch from another device and removes pixels immediately on stream closure", async () => {
  await render(false, "owner"); await click("local-browser-share-join");
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([255,216,255,217]).buffer })));
  expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:frame");
  await act(async () => socket.dispatchEvent(new Event("close")));
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("Connection closed");
  expect(document.querySelector('[data-testid="local-browser-share-join"]')).toBeNull();
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
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("local-browser-share-confirm");
  expect(viewers).toHaveBeenCalledTimes(1);

  const publication = vi.mocked(publishLocalBrowserTab).mock.calls[0];
  // Older state messages may omit the optional owner request lists.
  await act(async () => {
    publication[5]!({type:"controlState",available:true,connectionId:"owner",requested:false,grant:null});
    publication[6]!({type:"exploreState",available:true,requested:false,view:null});
  });
  expect(document.querySelector('[data-testid="local-browser-share-people"]')?.getAttribute("aria-label")).toBe("Sharing settings");
  await act(async () => publication[5]!({
    type: "controlState", available: true, connectionId: "owner", requested: false, grant: null,
    requests: [{ connectionId: "alice-tab", userId: "alice" }],
  }));
  expect(document.body.textContent).not.toContain("Alice requests control");
  expect(document.querySelector('[data-testid="local-browser-share-people"]')?.getAttribute("aria-label")).toContain("1 pending request");
  expect(viewers).toHaveBeenCalledTimes(2);
  await click("local-browser-share-people");
  expect(document.body.textContent).toContain("Alice requests control");
  expect(document.body.textContent).toContain("Alice · Following");
  expect(viewers).toHaveBeenCalledTimes(2);

  await act(async () => publication[6]!({
    type: "exploreState", available: true, requested: false, view: null,
    requests: [{ connectionId: "bob-tab", userId: "bob", viewport: { width: 390, height: 650, dpr: 2 } }],
    views: [],
  }));
  expect(document.body.textContent).toContain("Bob wants to browse independently");
  expect(viewers).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(viewers).toHaveBeenCalledTimes(4);
  await click("local-browser-share-people");
  const revoke = vi.fn().mockResolvedValue(undefined);
  const published = await vi.mocked(publishLocalBrowserTab).mock.results[0].value;
  published.control.revoke = revoke;
  await act(async () => publication[5]!({
    type:"controlState", available:true, connectionId:"owner", requested:false,
    grant:{id:"grant",connectionId:"alice-tab",userId:"alice"}, requests:[],
  }));
  expect(document.querySelector('[role="dialog"][aria-label="Sharing settings"]')).toBeNull();
  await click("local-tab-take-back");
  expect(revoke).toHaveBeenCalledTimes(1);
  await click("local-browser-share-people");
  const exploreButton = document.querySelector<HTMLButtonElement>('[data-testid="local-tab-allow-explore"]')!;
  await act(async () => exploreButton.focus());
  await act(async () => publication[6]!({type:"exploreState",available:true,requested:false,view:null,requests:[],views:[{viewId:"bob-view",connectionId:"bob-tab",userId:"bob",viewport:{width:390,height:650,dpr:2}},{viewId:"bob-view-2",connectionId:"bob-other-tab",userId:"bob",viewport:{width:1280,height:650,dpr:1}}]}));
  expect(document.querySelector('[data-testid="local-browser-share-audience"]')?.textContent).toContain("Alice · Controlling your tab");
  expect(document.querySelector('[data-testid="local-browser-share-audience"]')?.textContent).toContain("Bob · Browsing independently");
  expect(document.body.textContent).not.toContain("View only");
  expect(document.querySelectorAll('[data-testid="local-browser-share-person"]')).toHaveLength(2);
  expect(document.querySelectorAll('[data-testid="local-tab-end-explore"]')).toHaveLength(1);
  await click("local-tab-end-explore");
  expect(published.explore.close.mock.calls).toEqual([["bob-view"], ["bob-view-2"]]);
  expect(removeViewer).not.toHaveBeenCalled();
  // Failed closure retains its action and does not claim browsing has ended.
  published.explore.close.mockRejectedValueOnce(new Error("offline"));
  await click("local-tab-end-explore");
  expect(document.body.textContent).toContain("Could not end browsing");
  expect(document.querySelector('[data-testid="local-tab-end-explore"]')).not.toBeNull();
  await act(async () => publication[6]!({type:"exploreState",available:true,requested:false,view:null,requests:[],views:[]}));
  expect(document.querySelector('[data-testid="local-tab-end-explore"]')).toBeNull();
  expect(document.body.textContent).toContain("Bob · Following");

  expect(document.activeElement).toBe(document.querySelector('[role="dialog"][aria-label="Sharing settings"]'));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true})));
  expect(document.querySelector('[role="dialog"][aria-label="Sharing settings"]')).toBeNull();
  const pollsBeforeStop = viewers.mock.calls.length;
  await click("local-browser-share-stop");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(viewers).toHaveBeenCalledTimes(pollsBeforeStop);
});
