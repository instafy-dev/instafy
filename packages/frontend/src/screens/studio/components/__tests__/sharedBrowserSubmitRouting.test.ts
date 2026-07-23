import { describe, expect, it } from "vitest";
import {
  buildSharedBrowserSubmitMetadata,
  resolveSharedBrowserSubmitRouting,
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
