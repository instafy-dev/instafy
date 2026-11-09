// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatMessageFileChange } from "../../types";
import { ChatFileChangeList } from "../ChatFileChangeList";
import { CHAT_HISTORY_WAIT_MS, ChatSiteContext, chatHistoryIn, conversationSite, useKnownChatSite, type ChatSite } from "../chatSiteContext";

// Every file reads as 100 added lines. Nothing here may hit the network.
const fetchDiff = vi.hoisted(() =>
  vi.fn(async () => ({
    supported: true,
    diff: ["@@ -0,0 +1,100 @@", ...Array.from({ length: 100 }, (_, index) => `+line ${index}`)].join("\n"),
  })),
);

vi.mock("../../../../sdk/instafy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../sdk/instafy")>();
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      workspace: {
        ...actual.controllerClient.workspace,
        files: { ...actual.controllerClient.workspace.files, read: vi.fn() },
        git: { ...actual.controllerClient.workspace.git, fetchDiff, revertPaths: vi.fn() },
      },
    },
  };
});

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ effectiveRuntimeId: "runtime-1", runtimeReady: true }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openConversationTab: vi.fn(),
    openPanelTab: vi.fn(),
    requestUrlPush: vi.fn(),
    openGitDiffTab: vi.fn(),
  }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: vi.fn() }),
}));

const created = (path: string): ChatMessageFileChange => ({ path, changeType: "created" }) as ChatMessageFileChange;
const changed = (path: string): ChatMessageFileChange => ({ path, changeType: "changed" }) as ChatMessageFileChange;

describe("the files a site turn created", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function show(files: ChatMessageFileChange[], madeSite: boolean) {
    await act(async () => {
      root.render(<ChatFileChangeList files={files} projectId="project-1" madeSite={madeSite} />);
    });
    // The per-file stats load one after another.
    for (let index = 0; index < files.length + 2; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-toggle-files"]');
  const chips = () => container.querySelectorAll('[data-testid="chat-file-change-file-chip"]');

  // A local test: a map turn read "Created 35 files +16418" under its reply.
  it("reads Created the site, with no line count, and keeps the files one press away", async () => {
    await show(["map/index.html", "map/map.config.json", "map/engine.js", "map/style.css", "map/data.json"].map(created), true);
    expect(toggle()?.textContent).toBe("Created the site");
    expect(container.textContent).not.toMatch(/\+\d/u);
    expect(chips()).toHaveLength(0);
    await act(async () => toggle()?.click());
    expect(chips()).toHaveLength(5);
  });

  it("puts a one-file site behind the same chip", async () => {
    await show([created("hello-page/index.html")], true);
    expect(toggle()?.textContent).toBe("Created the site");
    expect(container.textContent).not.toContain("index.html");
  });

  it("keeps the file count where the chat has no site", async () => {
    await show(["a.md", "b.md", "c.md", "d.md", "e.md"].map(created), false);
    expect(toggle()?.textContent).toContain("Created 5 files");
  });

  // A local test, Nov 7: a chat with no card of its own changed a page's data
  // and read "data.json +23 −61" under its reply, which names a file, not the
  // page. Nov 9: such a chat's rows read "Changed framework-laptops-compare",
  // the folder's name, which is no word of the person's.
  it("reads as a page where the chat has no site, never by its folder or a file in it", async () => {
    await show([changed("sites/framework-laptops/data.json")], false);
    expect(toggle()?.textContent).toBe("Changed a page");
    expect(container.textContent).not.toMatch(/framework-laptops|data\.json|[+−-]\d/u);
    expect(chips()).toHaveLength(0);
    // Its files stay one press away.
    await act(async () => toggle()?.click());
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain("data.json");
    await show([changed("sites/lello-visit/app.js"), created("sites/lello-visit/notes/hours.md")], false);
    expect(toggle()?.textContent).toBe("Changed a page");
    // Files of two pages, or outside any page, keep their names and count.
    await show([changed("sites/a/data.json"), changed("sites/b/data.json")], false);
    expect(toggle()?.textContent).toContain("Edited 2 files");
    await show([changed("notes.md")], false);
    expect(toggle()).toBeNull();
    expect(chips()[0]?.textContent).toContain("notes.md");
  });

  // A local test: the map's hand-back read "sights.geojson +5 −2 ·
  // map.config.json +22 −4" under its reply.
  it("reads Changed the site for a site's files that were there, with no names or line counts", async () => {
    await show([created("site/index.html"), changed("README.md")], true);
    expect(toggle()?.textContent).toBe("Changed the site");
    await show([changed("lisbon/sights.geojson"), changed("lisbon/map.config.json")], true);
    expect(toggle()?.textContent).toBe("Changed the site");
    expect(container.textContent).not.toMatch(/sights|map\.config|[+−-]\d/u);
    expect(chips()).toHaveLength(0);
  });

  // A local test: the map turn opened no card of its own (a later turn did),
  // and read "lisbon-3-days +2724" under its reply.
  it("reads as the site in a chat that has a site, whichever turn opened its card", async () => {
    await act(async () => {
      root.render(
        <ChatSiteContext.Provider value={{ firstChangeAt: 1_000, pageTitles: new Map() }}>
          <ChatFileChangeList files={[created("lisbon-3-days")]} projectId="project-1" messageTimestamp={1_000} />
        </ChatSiteContext.Provider>,
      );
    });
    expect(toggle()?.textContent).toBe("Created the site");
    expect(container.textContent).not.toMatch(/lisbon|\+\d/u);
  });

  // In the map's chat, a later turn that only added files (a page, a list)
  // read "Created the site", as the turn that made it did.
  it("reads Changed the site for a later turn whose files are all new", async () => {
    await act(async () => {
      root.render(
        <ChatSiteContext.Provider value={{ firstChangeAt: 1_000, pageTitles: new Map() }}>
          <ChatFileChangeList files={[created("lisbon-3-days/packing.html")]} projectId="project-1" messageTimestamp={5_000} />
        </ChatSiteContext.Provider>,
      );
    });
    expect(toggle()?.textContent).toBe("Changed the site");
    // A turn that opened the card made its site, whenever it came.
    await act(async () => {
      root.render(
        <ChatSiteContext.Provider value={{ firstChangeAt: 1_000, pageTitles: new Map() }}>
          <ChatFileChangeList files={[created("hello/index.html")]} projectId="project-1" messageTimestamp={5_000} madeSite />
        </ChatSiteContext.Provider>,
      );
    });
    expect(toggle()?.textContent).toBe("Created the site");
  });

  // A local test, Nov 8: "Changed framework-13-vs-16" named a page by its
  // folder, and a map's row read "Changed seville-3-days" for 0.2 s on a
  // switch to its chat, then "Created the site".
  it("names every page by the title its card in this chat gives it, else as a page, never by its folder", async () => {
    const seville: ChatSite = { firstChangeAt: 1_000, pageTitles: new Map([["seville-3-days", "Three days in Seville"]]) };
    const show = async (site: ChatSite | null, files: ChatMessageFileChange[], messageTimestamp: number) => {
      await act(async () => {
        root.render(
          <ChatSiteContext.Provider value={site}>
            <ChatFileChangeList files={files} projectId="project-1" messageTimestamp={messageTimestamp} />
          </ChatSiteContext.Provider>,
        );
      });
    };
    await show(seville, ["sites/seville-3-days/index.html", "sites/seville-3-days/map.config.json"].map(created), 1_000);
    expect(toggle()?.textContent).toBe("Created Three days in Seville");
    await show(seville, [changed("sites/seville-3-days/map.config.json")], 5_000);
    expect(toggle()?.textContent).toBe("Changed Three days in Seville");
    // A page this chat holds no card of reads as a page, in a chat with a site or none.
    await show(seville, [changed("sites/framework-laptops/data.json")], 5_000);
    expect(toggle()?.textContent).toBe("Changed a page");
    await show(null, [changed("sites/framework-laptops/data.json")], 5_000);
    expect(toggle()?.textContent).toBe("Changed a page");
    // Files that are no one page's keep the site's line.
    await show(seville, [changed("sites/seville-3-days/map.config.json"), changed("README.md")], 5_000);
    expect(toggle()?.textContent).toBe("Changed the site");
  });

  it("waits for the chat's history rather than name its page one way, then another", async () => {
    const files = [changed("sites/seville-3-days/map.config.json")];
    const seen: string[] = [];
    const render = async (site: ChatSite | null | undefined) => {
      await act(async () => {
        root.render(
          <ChatSiteContext.Provider value={site}>
            <ChatFileChangeList files={files} projectId="project-1" messageTimestamp={5_000} />
          </ChatSiteContext.Provider>,
        );
      });
      seen.push(container.textContent ?? "");
    };
    // The history is still coming in: the card that names the page may yet arrive.
    await render(undefined);
    await render({ firstChangeAt: 1_000, pageTitles: new Map([["seville-3-days", "Three days in Seville"]]) });
    expect(seen[0]).toBe("");
    expect(seen.some((text) => text.includes("seville-3-days"))).toBe(false);
    expect(toggle()?.textContent).toBe("Changed Three days in Seville");
  });

  // A local test, Nov 8: on a switch back to a map's chat, its newest page of
  // history held the map turn's files and the note's, and not the map's card
  // (58th from newest): the rows read "Changed seville-3-days" until Studio
  // loaded the next page by itself to fill the window, 0.2 s later.
  it("waits while an older page of the chat comes by itself, then names the page by its card", async () => {
    const card: ChatMessage = { id: "card", role: "assistant", content: "", timestamp: 900, messageType: "action_request",
      metadata: { jobId: "map-job", messageType: "action_request",
        details: { title: "Three days in Seville", preview: { previewId: "11111111-1111-4111-8111-111111111111", port: 4173 } } } };
    const mapFiles = ["sites/seville-3-days/index.html", "sites/seville-3-days/map.config.json"].map(created);
    const noteFiles = [changed("sites/seville-3-days/map.config.json")];
    const newestPage: ChatMessage[] = [
      { id: "map-files", role: "assistant", content: "", timestamp: 1_000, metadata: { jobId: "map-job" }, files: mapFiles },
      { id: "note-files", role: "assistant", content: "", timestamp: 5_000, metadata: { jobId: "note-job" }, files: noteFiles },
    ];
    function Chat({ messages, history }: { messages: ChatMessage[]; history: Parameters<typeof chatHistoryIn>[0] }) {
      const site = useKnownChatSite(conversationSite(messages), chatHistoryIn(history), "chat-1");
      return (
        <ChatSiteContext.Provider value={site}>
          <ChatFileChangeList files={mapFiles} projectId="project-1" messageTimestamp={1_000} />
          <ChatFileChangeList files={noteFiles} projectId="project-1" messageTimestamp={5_000} />
        </ChatSiteContext.Provider>
      );
    }
    const labels = () => [...container.querySelectorAll('[data-testid="chat-file-change-toggle-files"]')].map((chip) => chip.textContent);
    const seen: string[] = [];
    const render = async (messages: ChatMessage[], history: Parameters<typeof chatHistoryIn>[0]) => {
      await act(async () => root.render(<Chat messages={messages} history={history} />));
      seen.push(container.textContent ?? "");
    };
    await render([], { newestPage: false, olderPageOnItsWay: false });
    await render(newestPage, { newestPage: true, olderPageOnItsWay: true });
    expect(seen).toEqual(["", ""]);
    await render([card, ...newestPage], { newestPage: true, olderPageOnItsWay: false });
    expect(labels()).toEqual(["Created Three days in Seville", "Changed Three days in Seville"]);
    expect(seen.some((text) => text.includes("seville-3-days"))).toBe(false);

    // In a window the newest page fills, no older page comes by itself: the
    // rows show at once, as a page until the person scrolls up to its card,
    // never by its folder.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(newestPage, { newestPage: true, olderPageOnItsWay: false });
    expect(labels()).toEqual(["Changed a page", "Changed a page"]);
    expect(container.textContent).not.toContain("seville-3-days");
  });

  // A local test, Nov 9: after a reload, the chat's first frame drew both of
  // a map's rows before its card ("Changed seville-three-days" twice), and
  // the next, 0.12 s later, named the page by its card. No frame names a
  // page by its folder.
  it("names a page by its folder in no frame, also before its card is drawn", async () => {
    const mapFiles = ["sites/seville-three-days/index.html", "sites/seville-three-days/map.config.json"].map(created);
    const noteFiles = [changed("sites/seville-three-days/map.config.json")];
    const seen: string[] = [];
    const render = async (site: ChatSite | null) => {
      await act(async () => root.render(
        <ChatSiteContext.Provider value={site}>
          <ChatFileChangeList files={mapFiles} projectId="project-1" messageTimestamp={1_000} />
          <ChatFileChangeList files={noteFiles} projectId="project-1" messageTimestamp={5_000} />
        </ChatSiteContext.Provider>,
      ));
      seen.push(container.textContent ?? "");
    };
    await render(null);
    await render({ firstChangeAt: 1_000, pageTitles: new Map([["seville-three-days", "Three days in Seville"]]) });
    expect(seen.filter((text) => text.includes("seville-three-days"))).toEqual([]);
    const labels = [...container.querySelectorAll('[data-testid="chat-file-change-toggle-files"]')].map((chip) => chip.textContent);
    expect(labels).toEqual(["Created Three days in Seville", "Changed Three days in Seville"]);
  });

  it("folds files shown before the chat had a site behind the site's line once it has one", async () => {
    const files = ["map/index.html", "map/data.json"].map(created);
    const render = async (hasSite: boolean) => {
      await act(async () => {
        root.render(
          <ChatSiteContext.Provider value={hasSite ? { firstChangeAt: 1_000, pageTitles: new Map() } : null}>
            <ChatFileChangeList files={files} projectId="project-1" messageTimestamp={1_000} />
          </ChatSiteContext.Provider>,
        );
      });
    };
    await render(false);
    expect(chips()).toHaveLength(2);
    await render(true);
    expect(toggle()?.textContent).toBe("Created the site");
    expect(chips()).toHaveLength(0);
  });
});

describe("the chat's site for its rows", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ChatSite | null | undefined = undefined;
  const site: ChatSite = { firstChangeAt: 1, pageTitles: new Map() };

  function Rows({ ready, chatKey }: { ready: boolean; chatKey: string }) {
    latest = useKnownChatSite(site, ready, chatKey);
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("is unknown until the chat's history is in, and known after a while if it never comes", async () => {
    await act(async () => root.render(<Rows ready={false} chatKey="chat-a" />));
    expect(latest).toBeUndefined();
    await act(async () => root.render(<Rows ready chatKey="chat-a" />));
    expect(latest).toBe(site);
    // Another chat waits for its own history, at most a few seconds.
    await act(async () => root.render(<Rows ready={false} chatKey="chat-b" />));
    expect(latest).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(CHAT_HISTORY_WAIT_MS - 1); });
    expect(latest).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(latest).toBe(site);
    // Waiting for one chat never stands for another.
    await act(async () => root.render(<Rows ready={false} chatKey="chat-c" />));
    expect(latest).toBeUndefined();
  });

  it("never hides a chat's rows again once they have shown", async () => {
    await act(async () => root.render(<Rows ready chatKey="chat-a" />));
    expect(latest).toBe(site);
    // The window grew taller, and an older page comes by itself to fill it.
    await act(async () => root.render(<Rows ready={false} chatKey="chat-a" />));
    expect(latest).toBe(site);
  });
});

describe("the chat's site", () => {
  const card = { id: "card", role: "assistant" as const, content: "", timestamp: 3_000, messageType: "action_request",
    metadata: { jobId: "open-job", messageType: "action_request",
      details: { title: "Lisbon in 3 days", preview: { previewId: "11111111-1111-4111-8111-111111111111", port: 4173 } } } };
  const files = (id: string, jobId: string, timestamp: number) => ({ id, role: "assistant" as const, content: "",
    timestamp, metadata: { jobId }, files: [created(`map/${id}.json`)] });

  it("names each page by the card of the turn whose files are that page's", () => {
    const pageCard = (id: string, jobId: string, title: string, timestamp: number) => ({ ...card, id, timestamp,
      metadata: { ...card.metadata, jobId, details: { ...card.metadata.details, title } } });
    const pageFiles = (id: string, jobId: string, paths: string[], timestamp: number) => ({ id, role: "assistant" as const,
      content: "", timestamp, metadata: { jobId }, files: paths.map(created) });
    const site = conversationSite([
      pageFiles("made", "make-job", ["sites/seville-3-days/index.html", "sites/seville-3-days/map.config.json"], 1_000),
      pageCard("card-1", "make-job", "Three days in Seville", 1_100),
      pageFiles("note", "note-job", ["sites/seville-3-days/map.config.json"], 2_000),
      // A turn whose files are two pages' names neither.
      pageFiles("both", "both-job", ["sites/a/data.json", "sites/b/data.json"], 3_000),
      pageCard("card-2", "both-job", "Two pages", 3_100),
    ]);
    expect([...site!.pageTitles]).toEqual([["seville-3-days", "Three days in Seville"]]);
    // The chat's one card names its one page, whichever turn opened it.
    const later = conversationSite([
      pageFiles("made", "make-job", ["sites/lisbon/index.html"], 1_000),
      pageCard("card-1", "open-job", "Lisbon in 3 days", 2_000),
    ]);
    expect([...later!.pageTitles]).toEqual([["lisbon", "Lisbon in 3 days"]]);
  });

  it("has none without a site's card, and dates its first change by that turn's newest files", () => {
    expect(conversationSite([files("a", "map-job", 1_000)])).toBeNull();
    // The map turn saved twice; its row shows the newer files, as the chat's first change.
    expect(conversationSite([files("a", "map-job", 1_000), files("b", "map-job", 2_000), card, files("c", "later-job", 4_000)]))
      .toEqual({ firstChangeAt: 2_000, pageTitles: new Map() });
    expect(conversationSite([card])).toEqual({ firstChangeAt: null, pageTitles: new Map() });
  });
});
