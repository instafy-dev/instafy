import { describe, expect, it } from "vitest";
import {
  resolvePreferredFilesMobileViewForExplorerOpen,
  resolveStudioFilesMobileView,
  resolveStudioFilesMobileViewChange,
} from "../studioFilesMobileView";

describe("resolveStudioFilesMobileView", () => {
  it("restores a preferred viewer across Back and Forward drawer history", () => {
    const preferredView = "viewer" as const;

    expect(
      resolveStudioFilesMobileView({
        isLargeScreen: false,
        leftDrawer: "files",
        preferredView,
      }),
    ).toBe("tree");
    expect(
      resolveStudioFilesMobileView({
        isLargeScreen: false,
        leftDrawer: null,
        preferredView,
      }),
    ).toBe("viewer");
    expect(
      resolveStudioFilesMobileView({
        isLargeScreen: false,
        leftDrawer: "files",
        preferredView,
      }),
    ).toBe("tree");
  });

  it("uses the tree immediately when resizing below the desktop breakpoint with Files open", () => {
    const preferredView = "viewer" as const;

    expect(
      resolveStudioFilesMobileView({
        isLargeScreen: true,
        leftDrawer: "files",
        preferredView,
      }),
    ).toBe("viewer");
    expect(
      resolveStudioFilesMobileView({
        isLargeScreen: false,
        leftDrawer: "files",
        preferredView,
      }),
    ).toBe("tree");
  });

  it("does not discard the preferred viewer when the URL-backed tree is open", () => {
    expect(
      resolveStudioFilesMobileViewChange({
        isLargeScreen: false,
        leftDrawer: "files",
        preferredView: "viewer",
        requestedView: "tree",
      }),
    ).toEqual({ preferredView: "viewer", shouldCloseExplorer: false });
  });

  it("records the viewer as the mobile history return target before opening the explorer", () => {
    expect(
      resolvePreferredFilesMobileViewForExplorerOpen({
        isLargeScreen: false,
        preferredView: "tree",
      }),
    ).toBe("viewer");
    expect(
      resolvePreferredFilesMobileViewForExplorerOpen({
        isLargeScreen: true,
        preferredView: "tree",
      }),
    ).toBe("tree");
  });

  it("turns one viewer request into one preferred-view update and close intent", () => {
    expect(
      resolveStudioFilesMobileViewChange({
        isLargeScreen: false,
        leftDrawer: "files",
        preferredView: "tree",
        requestedView: "viewer",
      }),
    ).toEqual({ preferredView: "viewer", shouldCloseExplorer: true });
  });
});
