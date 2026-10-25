import { describe, expect, it } from "vitest";
import {
  buildSharedBrowserSubmitMetadata,
  resolveSharedBrowserSendBlocker,
  resolveSharedBrowserSubmitRouting,
  SHARED_BROWSER_SEND_BLOCKER_STATUS,
  withPersonalBrowserRuntimeExpectations,
} from "../sharedBrowserSubmitRouting";

describe("Shared Browser submit routing", () => {
  it("pins an active browser task to the exact resolved runtime", () => {
    expect(
      resolveSharedBrowserSubmitRouting({
        active: true,
        messageRequiresAi: true,
        resolvedRuntimeId: " shared-runtime-1 ",
        terminalRequest: null,
      }),
    ).toEqual({
      kind: "shared",
      runtimeOverride: {
        runtimeId: "shared-runtime-1",
        runtimeDisplayName: null,
        preferRuntime: true,
      },
    });
  });

  it("blocks instead of falling back while the visible browser runtime is unresolved", () => {
    expect(
      resolveSharedBrowserSubmitRouting({
        active: true,
        messageRequiresAi: true,
        resolvedRuntimeId: null,
        terminalRequest: null,
      }),
    ).toEqual({ kind: "blocked", runtimeOverride: null });
  });

  it("leaves non-browser and terminal sends on standard routing", () => {
    expect(
      resolveSharedBrowserSubmitRouting({
        active: false,
        messageRequiresAi: true,
        resolvedRuntimeId: "shared-runtime-1",
        terminalRequest: null,
      }).kind,
    ).toBe("standard");
    expect(
      resolveSharedBrowserSubmitRouting({
        active: true,
        messageRequiresAi: true,
        resolvedRuntimeId: "shared-runtime-1",
        terminalRequest: { command: "pwd" },
      }).kind,
    ).toBe("standard");
  });

  it("attaches the transport, visible page, and browser execution contract", () => {
    expect(
      buildSharedBrowserSubmitMetadata({
        baseMetadata: {
          source: "composer",
          runtimeExpectations: { genericMcpToolExecution: false },
        },
        browserPageTarget: {
          id: "page-1",
          url: "https://example.com/",
          host: "example.com",
          label: "Example Domain",
        },
        runtimeId: "shared-runtime-1",
      }),
    ).toEqual({
      source: "composer",
      browserTransport: "shared",
      browserConsentVersion: 1,
      browserRuntimeId: "shared-runtime-1",
      browserPageId: "page-1",
      browserPageUrl: "https://example.com/",
      browserPageHost: "example.com",
      browserPageLabel: "Example Domain",
      runtimeExpectations: {
        genericMcpToolExecution: false,
        workspaceFileChanges: false,
        commandExecution: false,
        browserExecution: true,
      },
    });
  });

  it("requires bounded browser execution without a shell command for Personal Browser", () => {
    expect(
      withPersonalBrowserRuntimeExpectations({
        browserTransport: "desktop-personal",
      }),
    ).toEqual({
      browserTransport: "desktop-personal",
      runtimeExpectations: {
        workspaceFileChanges: false,
        commandExecution: false,
        browserExecution: true,
      },
    });
  });
});

describe("Shared Browser send blocker", () => {
  const ready = {
    active: true,
    messageRequiresAi: true,
    pageAvailable: true,
    resolvedRuntimeId: "shared-runtime-1",
    terminalRequest: null,
  };

  it("lets a send through once the browser runtime and a tab, even a blank one, are there", () => {
    expect(resolveSharedBrowserSendBlocker(ready)).toBeNull();
  });

  it("says the browser is still connecting while its runtime is unresolved", () => {
    expect(resolveSharedBrowserSendBlocker({ ...ready, resolvedRuntimeId: " " })).toBe("connecting");
    expect(resolveSharedBrowserSendBlocker({ ...ready, resolvedRuntimeId: null, pageAvailable: false })).toBe(
      "connecting",
    );
    expect(SHARED_BROWSER_SEND_BLOCKER_STATUS.connecting).toBe("Instafy's browser is still connecting.");
  });

  it("says the browser has no page while it has no tab to bind to", () => {
    expect(resolveSharedBrowserSendBlocker({ ...ready, pageAvailable: false })).toBe("no_page");
    expect(SHARED_BROWSER_SEND_BLOCKER_STATUS.no_page).toBe("Instafy's browser has no page open yet.");
  });

  it("never blocks a send that does not go to the browser", () => {
    const unready = { ...ready, resolvedRuntimeId: null, pageAvailable: false };
    expect(resolveSharedBrowserSendBlocker({ ...unready, active: false })).toBeNull();
    expect(resolveSharedBrowserSendBlocker({ ...unready, messageRequiresAi: false })).toBeNull();
    expect(resolveSharedBrowserSendBlocker({ ...unready, terminalRequest: { command: "pwd" } })).toBeNull();
  });
});
