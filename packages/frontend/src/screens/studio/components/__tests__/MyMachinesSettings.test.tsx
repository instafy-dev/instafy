// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyMachinesSettings, myMachineDetail } from "../MyMachinesSettings";
import type { MyMachine } from "../../../../sdk/instafy";

const mocks = vi.hoisted(() => ({
  userId: "user-a",
  listMine: vi.fn(),
  revokeMine: vi.fn(),
  showStatus: vi.fn(),
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  runtimes: { listMine: mocks.listMine, revokeMine: mocks.revokeMine },
} }));

const ONLINE = "11111111-1111-4111-8111-111111111111";
const BROWSER = "22222222-2222-4222-8222-222222222222";
const PENDING = "33333333-3333-4333-8333-333333333333";

function machine(overrides: Partial<MyMachine>): MyMachine {
  return {
    runtimeId: ONLINE,
    projectId: "space-a",
    projectReadable: true,
    projectName: "Garden plans",
    displayName: "Studio Mac",
    provider: "self-hosted",
    status: "ready",
    lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    mintedAt: null,
    personalBrowser: false,
    revoked: false,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * What the controller lists once it revoked these: every runtime still, each
 * marked revoked; one that was running is stopped as a person's Stop stops
 * it, which stamps last seen with the stop's own time, a moment after the
 * revocation's; a pending token it revoked is deleted, so it is gone.
 */
function afterRevoking(rows: MyMachine[], runtimeIds: string[]): MyMachine[] {
  const revokedMs = Date.now();
  const revokedAt = new Date(revokedMs).toISOString();
  const stoppedAt = new Date(revokedMs + 5).toISOString();
  return rows.flatMap((row) => {
    if (!runtimeIds.includes(row.runtimeId)) return [row];
    if (row.status === "pending") return [];
    if (["stopped", "offline", "removed"].includes(row.status)) return [{ ...row, revoked: true, revokedAt }];
    return [{ ...row, status: "stopped", lastSeenAt: stoppedAt, revoked: true, revokedAt }];
  });
}

function machines(): MyMachine[] {
  return [
    machine({}),
    machine({
      runtimeId: BROWSER,
      projectId: "space-b",
      projectReadable: false,
      projectName: null,
      displayName: null,
      status: "offline",
      lastSeenAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      personalBrowser: true,
    }),
    machine({
      runtimeId: PENDING,
      projectName: null,
      displayName: null,
      provider: null,
      status: "pending",
      lastSeenAt: null,
      mintedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    }),
  ];
}

describe("your machines settings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    mocks.userId = "user-a";
    mocks.listMine.mockReset();
    mocks.revokeMine.mockReset();
    mocks.showStatus.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    onlineManager.setOnline(true);
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MyMachinesSettings /></QueryClientProvider>));
  }
  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  async function press(testId: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button, testId).not.toBeNull();
    await act(async () => button!.click());
    await settle();
  }
  /** As from the keyboard: the control has focus when it is pressed. */
  async function pressFocused(testId: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button, testId).not.toBeNull();
    await act(async () => {
      button!.focus();
      button!.click();
    });
    await settle();
  }
  function rowText(runtimeId: string) {
    return container.querySelector(`[data-testid="my-machines-row-${runtimeId}"]`)?.textContent ?? null;
  }
  function revokeButton(runtimeId: string) {
    return container.querySelector<HTMLButtonElement>(`[data-testid="my-machines-revoke-${runtimeId}"]`);
  }
  function testId(id: string) {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }
  function sectionHeading() {
    return container.querySelector<HTMLElement>("h3");
  }

  it("lists your machines with their space, their state and when they were last seen", async () => {
    mocks.listMine.mockResolvedValue({ success: true, machines: machines() });
    await render();
    await settle();
    expect(rowText(ONLINE)).toBe("Studio MacGarden plans · Online · last seen 5m agoRevoke");
    expect(rowText(BROWSER)).toBe("Personal BrowserA space you can no longer open · Offline · last seen 3d agoRevoke");
    expect(rowText(PENDING)).toBe("New machineUntitled space · Token made 2h ago, not connected yetRevoke");
    expect(container.querySelector('[data-testid="my-machines-revoke-all"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a load error with Retry instead of a false empty list", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: false, machines: [], error: 'Unable to load your machines (503): {"error":"private detail"}' });
    await render();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your machines. Try again.");
    expect(container.textContent).not.toContain("private detail");
    expect(container.querySelector('[data-testid="my-machines-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-machines-revoke-all"]')).toBeNull();
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: [machine({})] });
    const retry = [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
    await act(async () => retry!.click());
    await settle();
    expect(rowText(ONLINE)).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("revokes one machine once you confirm, then lists it as revoked", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(machines(), [ONLINE]) });
    mocks.revokeMine.mockResolvedValue({ success: true, revoked: [ONLINE], pendingEnded: [] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await press(`my-machines-revoke-${ONLINE}`);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Revoke “Studio Mac” in Garden plans?"));
    expect(mocks.revokeMine).toHaveBeenCalledWith({ runtimeIds: [ONLINE] });
    expect(mocks.listMine).toHaveBeenCalledTimes(2);
    expect(mocks.showStatus).toHaveBeenCalledWith("Machine revoked.", "success", 2500);
    // The controller still lists it, stopped: it reads as revoked and offers
    // no second Revoke, while the others keep theirs and Revoke all stays.
    // Its stop stamped last seen after the revocation: no sighting to show.
    expect(rowText(ONLINE)).toBe("Studio MacGarden plans · Revoked just now");
    expect(revokeButton(ONLINE)).toBeNull();
    expect(revokeButton(BROWSER)?.disabled).toBe(false);
    expect(revokeButton(PENDING)?.disabled).toBe(false);
    expect(testId("my-machines-revoke-all")).not.toBeNull();
    expect(testId("my-machines-empty")).toBeNull();
    // Pressed without focus (a mouse click in Safari, a script), it leaves
    // focus alone.
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus from a revoked row's Revoke to that row once the list shows it revoked", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(machines(), [ONLINE]) });
    mocks.revokeMine.mockResolvedValue({ success: true, revoked: [ONLINE], pendingEnded: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await pressFocused(`my-machines-revoke-${ONLINE}`);
    expect(rowText(ONLINE)).toBe("Studio MacGarden plans · Revoked just now");
    expect(revokeButton(ONLINE)).toBeNull();
    expect(document.activeElement).toBe(testId(`my-machines-row-${ONLINE}`));
  });

  it.each([
    { target: "the next row's Revoke", order: [PENDING, ONLINE, BROWSER], focused: () => revokeButton(ONLINE) },
    { target: "the list when no row came after it", order: [ONLINE, BROWSER, PENDING], focused: () => testId("my-machines-list") },
    { target: "the section heading when no row is left", order: [PENDING], focused: () => sectionHeading() },
  ])("moves focus to $target once a pending token it revoked is gone", async ({ order, focused }) => {
    const rows = order.map((runtimeId) => machines().find((row) => row.runtimeId === runtimeId)!);
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: rows })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(rows, [PENDING]) });
    mocks.revokeMine.mockResolvedValue({ success: true, revoked: [], pendingEnded: [PENDING] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await pressFocused(`my-machines-revoke-${PENDING}`);
    expect(mocks.showStatus).toHaveBeenCalledWith("Machine revoked.", "success", 2500);
    expect(rowText(PENDING)).toBeNull();
    expect(focused()).not.toBeNull();
    expect(document.activeElement).toBe(focused());
  });

  it("revokes nothing when you cancel", async () => {
    mocks.listMine.mockResolvedValue({ success: true, machines: machines() });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    await settle();
    await press(`my-machines-revoke-${PENDING}`);
    await press("my-machines-revoke-all");
    expect(mocks.revokeMine).not.toHaveBeenCalled();
    expect(mocks.listMine).toHaveBeenCalledTimes(1);
  });

  it("revokes all your machines, the ones it does not list included", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(machines(), [ONLINE, BROWSER, PENDING]) });
    mocks.revokeMine.mockResolvedValue({ success: true, revoked: [ONLINE, BROWSER], pendingEnded: [PENDING] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await press("my-machines-revoke-all");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Revoke all your machines? Their access ends now, in every space"));
    expect(mocks.revokeMine).toHaveBeenCalledWith({ all: true });
    expect(mocks.showStatus).toHaveBeenCalledWith("Your machines were revoked.", "success", 2500);
    // Every runtime is listed still, as revoked, and the pending token is
    // gone: nothing is left to revoke, yet this is not an empty list. The
    // offline one was not stopped, so its sighting from before stays.
    expect(rowText(ONLINE)).toBe("Studio MacGarden plans · Revoked just now");
    expect(rowText(BROWSER)).toBe("Personal BrowserA space you can no longer open · Revoked just now · last seen 3d ago");
    expect(rowText(PENDING)).toBeNull();
    expect(container.querySelectorAll('[data-testid^="my-machines-revoke-"]')).toHaveLength(0);
    expect(testId("my-machines-empty")).toBeNull();
  });

  it("moves focus to the list once Revoke all leaves nothing to revoke", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(machines(), [ONLINE, BROWSER, PENDING]) });
    mocks.revokeMine.mockResolvedValue({ success: true, revoked: [ONLINE, BROWSER], pendingEnded: [PENDING] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await pressFocused("my-machines-revoke-all");
    expect(mocks.showStatus).toHaveBeenCalledWith("Your machines were revoked.", "success", 2500);
    expect(testId("my-machines-revoke-all")).toBeNull();
    expect(document.activeElement).toBe(testId("my-machines-list"));
  });

  it("keeps focus on a Revoke while it works and after it fails", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.listMine.mockResolvedValue({ success: true, machines: machines() });
    mocks.revokeMine.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await pressFocused(`my-machines-revoke-${BROWSER}`);
    // Pending, not disabled: a browser takes focus off a disabled button.
    const working = revokeButton(BROWSER);
    expect(working?.getAttribute("aria-disabled")).toBe("true");
    expect(working?.disabled).toBe(false);
    expect(document.activeElement).toBe(working);
    expect(revokeButton(ONLINE)?.disabled).toBe(true);
    expect(testId("my-machines-revoke-all")?.hasAttribute("disabled")).toBe(true);

    await act(async () => { finish({ success: false, error: "No machine of yours has that id." }); });
    await settle();
    expect(mocks.showStatus).toHaveBeenCalledWith("No machine of yours has that id.", "error", 4500);
    expect(revokeButton(BROWSER)?.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(revokeButton(BROWSER));
  });

  it("leaves focus where you moved it while a revocation ran", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(machines(), [ONLINE]) });
    mocks.revokeMine.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    try {
      await render();
      await settle();
      await pressFocused(`my-machines-revoke-${ONLINE}`);
      act(() => elsewhere.focus());
      await act(async () => { finish({ success: true, revoked: [ONLINE], pendingEnded: [] }); });
      await settle();
      expect(revokeButton(ONLINE)).toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it("says there was nothing to revoke when the machine was revoked elsewhere meanwhile", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: true, machines: afterRevoking(machines(), [ONLINE]) });
    // Another tab or the CLI revoked it after this list was read: the
    // controller accepts the id, skips the machine and ends nothing.
    mocks.revokeMine.mockResolvedValue({ success: true, revoked: [], pendingEnded: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await press(`my-machines-revoke-${ONLINE}`);
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    expect(mocks.showStatus).toHaveBeenCalledWith("There was nothing to revoke.", "success", 2500);
    expect(rowText(ONLINE)).toBe("Studio MacGarden plans · Revoked just now");
    expect(revokeButton(ONLINE)).toBeNull();
  });

  it("names the one space a row's access ends in, in its confirmation and on its button", async () => {
    const PENDING_ELSEWHERE = "55555555-5555-4555-8555-555555555555";
    mocks.listMine.mockResolvedValue({ success: true, machines: [
      ...machines(),
      machine({
        runtimeId: PENDING_ELSEWHERE,
        projectId: "space-c",
        projectReadable: false,
        projectName: null,
        displayName: null,
        provider: null,
        status: "pending",
        lastSeenAt: null,
        mintedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }),
    ] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    await settle();
    const page = testId("my-machines-settings")?.textContent ?? "";
    expect(page).toContain("A computer used in several spaces is listed once per space.");
    expect(page).toContain("Revoke one you lost or no longer use: its access to that space ends now");
    expect(page).toContain("Revoke all ends every one, in every space.");

    // One computer has a row under the same name in each space it is used
    // in, so each button says which space it revokes.
    expect(revokeButton(ONLINE)?.getAttribute("aria-label")).toBe("Revoke Studio Mac in Garden plans");
    expect(revokeButton(BROWSER)?.getAttribute("aria-label")).toBe("Revoke Personal Browser in a space you can no longer open");
    expect(revokeButton(PENDING)?.getAttribute("aria-label")).toBe("Revoke New machine in Untitled space");
    const describedBy = revokeButton(PENDING)?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("Untitled space · Token made 2h ago, not connected yet");

    await press(`my-machines-revoke-${ONLINE}`);
    expect(confirm).toHaveBeenLastCalledWith(
      "Revoke “Studio Mac” in Garden plans? Its access to that space ends now, and it stops if it is running. To use it there again, start it again from Instafy on that machine.",
    );
    // Starting a machine in a space takes access to it: a space you can no
    // longer open offers no way back, so its confirmation promises none.
    await press(`my-machines-revoke-${BROWSER}`);
    expect(confirm).toHaveBeenLastCalledWith(
      "Revoke “Personal Browser” in a space you can no longer open? Its access to that space ends now, and it stops if it is running. You can't use it there again unless you get access to that space back.",
    );
    // No machine has used a pending token yet, so nothing stops.
    await press(`my-machines-revoke-${PENDING}`);
    expect(confirm).toHaveBeenLastCalledWith(
      "Revoke “New machine” in Untitled space? No machine has connected with its token yet, and the token stops working now. To connect a machine there, start it from Instafy on that machine.",
    );
    await press(`my-machines-revoke-${PENDING_ELSEWHERE}`);
    expect(confirm).toHaveBeenLastCalledWith(
      "Revoke “New machine” in a space you can no longer open? No machine has connected with its token yet, and the token stops working now. You can't connect a machine there unless you get access to that space back.",
    );
    for (const [question] of confirm.mock.calls) expect(question).not.toContain("every space");
    await press("my-machines-revoke-all");
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Their access ends now, in every space"));
    expect(mocks.revokeMine).not.toHaveBeenCalled();
  });

  it("says it is offline, never that you have no machines, while the first read waits for a connection", async () => {
    onlineManager.setOnline(false);
    mocks.listMine.mockResolvedValue({ success: true, machines: machines() });
    await render();
    await settle();
    expect(mocks.listMine).not.toHaveBeenCalled();
    expect(testId("my-machines-offline")?.textContent).toBe("You're offline. Your machines show here once you're back online.");
    expect(testId("my-machines-empty")).toBeNull();
    expect(testId("my-machines-list")).toBeNull();
    expect(testId("my-machines-revoke-all")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => { onlineManager.setOnline(true); });
    await settle();
    expect(mocks.listMine).toHaveBeenCalledTimes(1);
    expect(testId("my-machines-offline")).toBeNull();
    expect(rowText(ONLINE)).not.toBeNull();
    expect(revokeButton(ONLINE)?.disabled).toBe(false);
  });

  it("keeps the list it read, without Revoke all, while a refresh waits for a connection", async () => {
    mocks.listMine.mockResolvedValue({ success: true, machines: machines() });
    await render();
    await settle();
    onlineManager.setOnline(false);
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["my-machines", "user-a"] }); });
    await settle();
    expect(mocks.listMine).toHaveBeenCalledTimes(1);
    expect(testId("my-machines-offline")?.textContent).toBe("You're offline. Your machines refresh once you're back online.");
    expect(rowText(ONLINE)).not.toBeNull();
    expect(testId("my-machines-revoke-all")?.hasAttribute("disabled")).toBe(true);
    expect(testId("my-machines-empty")).toBeNull();
  });

  it("says why a revocation failed and reads the list again", async () => {
    mocks.listMine.mockResolvedValue({ success: true, machines: machines() });
    mocks.revokeMine.mockResolvedValue({ success: false, error: "No machine of yours has that id." });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await press(`my-machines-revoke-${BROWSER}`);
    expect(mocks.showStatus).toHaveBeenCalledWith("No machine of yours has that id.", "error", 4500);
    expect(mocks.listMine).toHaveBeenCalledTimes(2);
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="my-machines-revoke-${BROWSER}"]`);
    expect(button?.textContent).toBe("Revoke");
    expect(button?.disabled).toBe(false);
  });

  it("shows when you have no machines", async () => {
    mocks.listMine.mockResolvedValue({ success: true, machines: [] });
    await render();
    await settle();
    expect(container.querySelector('[data-testid="my-machines-empty"]')?.textContent).toContain("No machines.");
    expect(container.querySelector('[data-testid="my-machines-revoke-all"]')).toBeNull();
  });

  it("hides a list it could not refresh, so nothing is revoked from an old one", async () => {
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValueOnce({ success: false, machines: [], error: "Unable to load your machines" });
    await render();
    await settle();
    expect(rowText(ONLINE)).not.toBeNull();
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["my-machines", "user-a"] }); });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't refresh your machines. Try again.");
    expect(container.querySelector('[data-testid="my-machines-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-machines-revoke-all"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-machines-empty"]')).toBeNull();
  });

  it("starts afresh for the next person who signs in, whatever the last one left pending", async () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    let finish: (value: unknown) => void = () => {};
    mocks.listMine.mockResolvedValueOnce({ success: true, machines: machines() })
      .mockResolvedValue({ success: true, machines: [machine({ runtimeId: OTHER, displayName: "Work laptop" })] });
    mocks.revokeMine.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();
    await press(`my-machines-revoke-${ONLINE}`);
    expect(revokeButton(ONLINE)?.getAttribute("aria-disabled")).toBe("true");

    mocks.userId = "user-b";
    await render();
    await settle();
    const button = () => container.querySelector<HTMLButtonElement>(`[data-testid="my-machines-revoke-${OTHER}"]`);
    expect(button()?.textContent).toBe("Revoke");
    expect(button()?.hasAttribute("aria-disabled")).toBe(false);
    expect(button()?.disabled).toBe(false);

    // The first person's revocation ends after they left: nothing of it
    // reaches the next person's view.
    await act(async () => { finish({ success: true, revoked: [ONLINE], pendingEnded: [] }); });
    await settle();
    expect(mocks.showStatus).not.toHaveBeenCalled();
    expect(button()?.disabled).toBe(false);
  });

  it("names a machine's state and age plainly", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(myMachineDetail(machine({ lastSeenAt: "2026-11-18T11:59:50Z" }), now)).toBe("Garden plans · Online · last seen just now");
    expect(myMachineDetail(machine({ status: "removed", lastSeenAt: "2026-11-16T12:00:00Z" }), now)).toBe("Garden plans · Removed · last seen 2d ago");
    expect(myMachineDetail(machine({ status: "Mystery", lastSeenAt: null }), now)).toBe("Garden plans · Mystery");
    expect(myMachineDetail(machine({ personalBrowser: true, lastSeenAt: null }), now)).toBe("Garden plans · Personal Browser · Online");
    expect(myMachineDetail(machine({ status: "pending", lastSeenAt: null, mintedAt: null }), now)).toBe("Garden plans · Not connected yet");
  });

  it("names a revoked machine as revoked, and when, with last seen only for a sighting from before", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(myMachineDetail(machine({
      status: "stopped", revoked: true, revokedAt: "2026-11-18T10:00:00Z", lastSeenAt: "2026-11-15T12:00:00Z",
    }), now)).toBe("Garden plans · Revoked 2h ago · last seen 3d ago");
    expect(myMachineDetail(machine({
      status: "offline", revoked: true, revokedAt: "2026-11-18T11:59:40Z", lastSeenAt: "2026-11-15T11:59:40Z",
    }), now)).toBe("Garden plans · Revoked just now · last seen 3d ago");
    // Revoking a running machine stops it, and the stop stamps last seen a
    // moment after the revocation: the controller's own, not a sighting.
    expect(myMachineDetail(machine({
      status: "stopped", revoked: true, revokedAt: "2026-11-18T11:59:40.123456Z", lastSeenAt: "2026-11-18T11:59:40.204512Z",
    }), now)).toBe("Garden plans · Revoked just now");
    expect(myMachineDetail(machine({
      status: "stopped", revoked: true, revokedAt: "2026-11-18T11:59:40Z", lastSeenAt: "2026-11-18T11:59:40Z",
    }), now)).toBe("Garden plans · Revoked just now");
    expect(myMachineDetail(machine({
      status: "offline", personalBrowser: true, revoked: true, revokedAt: "2026-11-18T11:59:40Z", lastSeenAt: null,
    }), now)).toBe("Garden plans · Personal Browser · Revoked just now");
    // Without the revocation's time, no stamp is known to come before it.
    expect(myMachineDetail(machine({
      projectReadable: false, projectName: null, status: "removed", revoked: true, revokedAt: null, lastSeenAt: "2026-11-17T12:00:00Z",
    }), now)).toBe("A space you can no longer open · Revoked");
  });
});
