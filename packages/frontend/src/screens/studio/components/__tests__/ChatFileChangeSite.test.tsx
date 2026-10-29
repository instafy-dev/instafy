// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageFileChange } from "../../types";
import { ChatFileChangeList } from "../ChatFileChangeList";
import { ChatHasSiteContext } from "../chatSiteContext";

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
        <ChatHasSiteContext.Provider value>
          <ChatFileChangeList files={[created("lisbon-3-days")]} projectId="project-1" />
        </ChatHasSiteContext.Provider>,
      );
    });
    expect(toggle()?.textContent).toBe("Created the site");
    expect(container.textContent).not.toMatch(/lisbon|\+\d/u);
  });
});
