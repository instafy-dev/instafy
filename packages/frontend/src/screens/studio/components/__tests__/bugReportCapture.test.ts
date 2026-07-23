import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureCurrentScreenBugReportDraft } from "../bugReportCapture";

const cloneNodeMock = vi.fn();
const embedWebFontsMock = vi.fn();
const embedImagesMock = vi.fn();
const applyStyleMock = vi.fn();
const getImageSizeMock = vi.fn();
const getPixelRatioMock = vi.fn();
const checkCanvasDimensionsMock = vi.fn();
const nodeToDataURLMock = vi.fn();
const createImageMock = vi.fn();

vi.mock("html-to-image/lib/clone-node", () => ({
  cloneNode: (...args: unknown[]) => cloneNodeMock(...args),
}));

vi.mock("html-to-image/lib/embed-webfonts", () => ({
  embedWebFonts: (...args: unknown[]) => embedWebFontsMock(...args),
}));

vi.mock("html-to-image/lib/embed-images", () => ({
  embedImages: (...args: unknown[]) => embedImagesMock(...args),
}));

vi.mock("html-to-image/lib/apply-style", () => ({
  applyStyle: (...args: unknown[]) => applyStyleMock(...args),
}));

vi.mock("html-to-image/lib/util", () => ({
  getImageSize: (...args: unknown[]) => getImageSizeMock(...args),
  getPixelRatio: (...args: unknown[]) => getPixelRatioMock(...args),
  checkCanvasDimensions: (...args: unknown[]) => checkCanvasDimensionsMock(...args),
  nodeToDataURL: (...args: unknown[]) => nodeToDataURLMock(...args),
  createImage: (...args: unknown[]) => createImageMock(...args),
}));

class MockElement {
  id = "";
  tagName: string;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: MockElement[] = [];
  parent: MockElement | null = null;
  ownerDocument: {
    createElement: (tagName: string) => MockElement;
  } | null = null;
  scrollTop = 0;
  scrollLeft = 0;
  width = 0;
  height = 0;

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
  }

  append(...children: MockElement[]) {
    children.forEach((child) => {
      this.appendChild(child);
    });
  }

  appendChild(child: MockElement) {
    if (child.parent) {
      child.parent.children = child.parent.children.filter((candidate) => candidate !== child);
    }
    child.parent = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  cloneNode() {
    const clone = new MockElement(this.tagName);
    clone.id = this.id;
    clone.style = { ...this.style };
    clone.attributes = new Map(this.attributes);
    clone.ownerDocument = this.ownerDocument;
    clone.scrollTop = this.scrollTop;
    clone.scrollLeft = this.scrollLeft;
    clone.width = this.width;
    clone.height = this.height;
    clone.children = this.children.map((child) => {
      const childClone = child.cloneNode() as MockElement;
      childClone.parent = clone;
      return childClone;
    });
    return clone;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  matches(selector: string) {
    if (selector === "*") {
      return true;
    }
    if (selector.startsWith("#")) {
      return this.id === selector.slice(1);
    }
    const attrMatch = selector.match(/^\[(.+?)=['"](.+?)['"]\]$/);
    if (attrMatch) {
      return this.getAttribute(attrMatch[1]) === attrMatch[2];
    }
    return false;
  }

  closest(selector: string): MockElement | null {
    if (this.matches(selector)) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }

  querySelector(selector: string): MockElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) {
        return child;
      }
      const nested: MockElement | null = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    for (const child of this.children) {
      if (selector === "*" || child.matches(selector)) {
        results.push(child);
      }
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
}

class MockCanvasElement extends MockElement {
  getContext = vi.fn(() => ({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  }));

  toDataURL = vi.fn(() => "data:image/png;base64,ZmFrZQ==");

  constructor() {
    super("canvas");
  }
}

describe("captureCurrentScreenBugReportDraft", () => {
  const realWindow = globalThis.window;
  const realDocument = globalThis.document;
  const realElement = globalThis.Element;
  const realHTMLElement = globalThis.HTMLElement;
  const realGetComputedStyle = globalThis.getComputedStyle;

  const body = new MockElement("body") as unknown as HTMLElement;
  const scroller = new MockElement("div");
  const captureTarget = new MockElement("div");
  const overlayParent = new MockElement("div");
  const overlayChild = new MockElement("div");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T07:40:12.345Z"));

    cloneNodeMock.mockReset();
    embedWebFontsMock.mockReset();
    embedImagesMock.mockReset();
    applyStyleMock.mockReset();
    getImageSizeMock.mockReset();
    getPixelRatioMock.mockReset();
    checkCanvasDimensionsMock.mockReset();
    nodeToDataURLMock.mockReset();
    createImageMock.mockReset();

    scroller.id = "scroller";
    scroller.scrollTop = 120;
    scroller.scrollLeft = 8;

    captureTarget.id = "capture-target";
    overlayParent.setAttribute("data-bug-report-overlay", "true");
    overlayChild.id = "overlay-child";

    overlayParent.children = [];
    overlayParent.append(overlayChild);
    scroller.children = [];
    scroller.append(captureTarget, overlayParent);
    (body as unknown as MockElement).children = [];
    (body as unknown as MockElement).append(scroller);

    cloneNodeMock.mockImplementation(async (node: MockElement) => node.cloneNode());
    embedWebFontsMock.mockResolvedValue(undefined);
    embedImagesMock.mockResolvedValue(undefined);
    applyStyleMock.mockImplementation((node: MockElement) => node);
    getImageSizeMock.mockReturnValue({ width: 390, height: 844 });
    getPixelRatioMock.mockReturnValue(2);
    nodeToDataURLMock.mockResolvedValue("data:image/svg+xml;base64,ZmFrZQ==");
    createImageMock.mockResolvedValue({ width: 390, height: 844 });

    vi.stubGlobal("Element", MockElement);
    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("window", {
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 3,
    });
    vi.stubGlobal("document", {
      body,
      getElementById() {
        return null;
      },
      createElement(tagName: string) {
        if (tagName === "canvas") {
          return new MockCanvasElement();
        }
        return new MockElement(tagName);
      },
    });
    const assignOwnerDocument = (
      element: MockElement,
      ownerDocument: NonNullable<typeof globalThis.document>,
    ) => {
      element.ownerDocument = ownerDocument as unknown as MockElement["ownerDocument"];
      element.children.forEach((child) => assignOwnerDocument(child, ownerDocument));
    };
    assignOwnerDocument(body as unknown as MockElement, globalThis.document);
    vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "rgb(1, 2, 3)" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (realWindow === undefined) {
      // @ts-expect-error cleanup
      delete globalThis.window;
    } else {
      vi.stubGlobal("window", realWindow);
    }
    if (realDocument === undefined) {
      // @ts-expect-error cleanup
      delete globalThis.document;
    } else {
      vi.stubGlobal("document", realDocument);
    }
    if (realElement === undefined) {
      // @ts-expect-error cleanup
      delete globalThis.Element;
    } else {
      vi.stubGlobal("Element", realElement);
    }
    if (realHTMLElement === undefined) {
      // @ts-expect-error cleanup
      delete globalThis.HTMLElement;
    } else {
      vi.stubGlobal("HTMLElement", realHTMLElement);
    }
    if (realGetComputedStyle === undefined) {
      // @ts-expect-error cleanup
      delete globalThis.getComputedStyle;
    } else {
      vi.stubGlobal("getComputedStyle", realGetComputedStyle);
    }
    vi.unstubAllGlobals();
  });

  it("filters bug-report overlays out of the captured screenshot and preserves scroll state", async () => {
    const draft = await captureCurrentScreenBugReportDraft();

    expect(cloneNodeMock).toHaveBeenCalledTimes(1);
    const [node, options] = cloneNodeMock.mock.calls[0] as [MockElement, {
      filter: (currentNode: unknown) => boolean;
      pixelRatio: number;
      width: number;
      height: number;
      backgroundColor: string;
    }];

    expect(node).toBe(body);
    expect(options.pixelRatio).toBe(2);
    expect(options.width).toBe(390);
    expect(options.height).toBe(844);
    expect(options.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(options.filter(captureTarget)).toBe(true);
    expect(options.filter(overlayChild)).toBe(false);

    const [clonedNode] = nodeToDataURLMock.mock.calls[0] as [MockElement];
    const clonedScroller = clonedNode.querySelector("#scroller");
    expect(clonedScroller).not.toBeNull();
    expect(clonedScroller?.style.overflow).toBe("hidden");
    const translatedWrapper = clonedScroller?.children[0];
    expect(translatedWrapper?.getAttribute("data-bug-report-scroll-wrapper")).toBe("true");
    expect(translatedWrapper?.style.transform).toBe("translate(-8px, -120px)");
    expect(scroller.hasAttribute("data-bug-report-scroll-id")).toBe(false);

    expect(draft.fileName).toBe("instafy-screen-2026-03-18T07-40-12-345Z.png");
    expect(draft.previewUrl).toBe("data:image/png;base64,ZmFrZQ==");
  });

  it("still captures when font and image embedding fail", async () => {
    embedWebFontsMock.mockRejectedValueOnce(new Error("fonts failed"));
    embedImagesMock.mockRejectedValueOnce(new Error("images failed"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const draft = await captureCurrentScreenBugReportDraft();
      expect(draft.previewUrl).toBe("data:image/png;base64,ZmFrZQ==");
      expect(nodeToDataURLMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
