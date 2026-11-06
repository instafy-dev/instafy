import { describe, expect, it } from "vitest";
import { hasSameOriginAncestor } from "../frameContext";

const INSTAFY = "https://prod.instafy.dev";

type FakeWindow = { origin?: string; parent?: unknown; location?: { origin?: string } };

function securityError(): DOMException {
  return new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
}

/** A top-level window is its own parent. */
function topWindow(origin: string): FakeWindow {
  const win: FakeWindow = { origin, location: { origin } };
  win.parent = win;
  return win;
}

function frameIn(parent: FakeWindow, origin: string): FakeWindow {
  return { origin, location: { origin }, parent };
}

/** A window on another origin: its parent can be read, its location cannot. */
function crossOriginWindow(parent?: FakeWindow): FakeWindow {
  const win: FakeWindow = {
    get location(): never {
      throw securityError();
    },
  };
  win.parent = parent ?? win;
  return win;
}

describe("hasSameOriginAncestor", () => {
  it("is false outside a browser and in a top-level window", () => {
    expect(hasSameOriginAncestor(undefined)).toBe(false);
    expect(hasSameOriginAncestor(topWindow(INSTAFY))).toBe(false);
  });

  it("is true in a frame whose parent is on the same origin, whatever is above it", () => {
    expect(hasSameOriginAncestor(frameIn(topWindow(INSTAFY), INSTAFY))).toBe(true);
    // Studio embedded by an extension, with an Instafy page inside it.
    expect(hasSameOriginAncestor(frameIn(frameIn(crossOriginWindow(), INSTAFY), INSTAFY))).toBe(true);
  });

  // A site preview on its own origin inside Studio, navigated to the app.
  it("finds a same-origin grandparent behind a parent on another origin", () => {
    expect(hasSameOriginAncestor(frameIn(crossOriginWindow(topWindow(INSTAFY)), INSTAFY))).toBe(true);
  });

  it("is false when every ancestor is on another origin", () => {
    expect(hasSameOriginAncestor(frameIn(crossOriginWindow(), INSTAFY))).toBe(false);
    expect(hasSameOriginAncestor(frameIn(crossOriginWindow(crossOriginWindow()), INSTAFY))).toBe(false);
    expect(hasSameOriginAncestor(frameIn(topWindow("https://example.test"), INSTAFY))).toBe(false);
  });

  // A sandboxed frame's origin is opaque: it serializes as "null" and shares
  // nothing, even with a parent that serializes the same.
  it("is false for an opaque origin or none", () => {
    expect(hasSameOriginAncestor(frameIn(topWindow("null"), "null"))).toBe(false);
    expect(hasSameOriginAncestor({ parent: topWindow(INSTAFY) })).toBe(false);
  });

  it("is false when the frame's own origin or its parent cannot be read", () => {
    const unreadableOrigin: FakeWindow = {
      get origin(): never {
        throw securityError();
      },
      parent: topWindow(INSTAFY),
    };
    expect(hasSameOriginAncestor(unreadableOrigin)).toBe(false);

    const unreadableParent: FakeWindow = {
      origin: INSTAFY,
      get parent(): never {
        throw securityError();
      },
    };
    expect(hasSameOriginAncestor(unreadableParent)).toBe(false);
  });
});
