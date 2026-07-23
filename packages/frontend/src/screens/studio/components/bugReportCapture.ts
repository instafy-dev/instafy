import type { Options as HtmlToImageOptions } from "html-to-image/lib/types";
import { buildBugReportScreenshotDraftFromDataUrl, type BugReportScreenshotDraft } from "./bugReportDrafts";

const BUG_REPORT_SCROLL_ATTR = "data-bug-report-scroll-id";
const BUG_REPORT_SCROLL_WRAPPER_ATTR = "data-bug-report-scroll-wrapper";

interface ScrollSnapshot {
  id: string;
  top: number;
  left: number;
  restoreAttribute: string | null;
  layout: {
    display: string;
    flexDirection: string;
    flexWrap: string;
    justifyContent: string;
    alignItems: string;
    alignContent: string;
    gap: string;
    rowGap: string;
    columnGap: string;
    gridTemplateColumns: string;
    gridTemplateRows: string;
    gridAutoColumns: string;
    gridAutoRows: string;
    gridAutoFlow: string;
    placeItems: string;
    placeContent: string;
  };
}

function resolveCaptureNode(): HTMLElement {
  if (document.body instanceof HTMLElement) {
    return document.body;
  }
  const root = document.getElementById("root");
  if (root instanceof HTMLElement) {
    return root;
  }
  throw new Error("Unable to capture the current screen.");
}

function buildScreenshotFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `instafy-screen-${stamp}.png`;
}

function getScrollableElements(node: HTMLElement): HTMLElement[] {
  return [node, ...Array.from(node.querySelectorAll<HTMLElement>("*"))];
}

function captureScrollSnapshots(node: HTMLElement): ScrollSnapshot[] {
  let nextId = 0;
  return getScrollableElements(node)
    .map((element) => {
      const top = element.scrollTop;
      const left = element.scrollLeft;
      if (top === 0 && left === 0) {
        return null;
      }
      const restoreAttribute = element.getAttribute(BUG_REPORT_SCROLL_ATTR);
      const id = restoreAttribute ?? `bug-report-scroll-${nextId++}`;
      const computed = getComputedStyle(element);
      element.setAttribute(BUG_REPORT_SCROLL_ATTR, id);
      return {
        id,
        top,
        left,
        restoreAttribute,
        layout: {
          display: computed.display,
          flexDirection: computed.flexDirection,
          flexWrap: computed.flexWrap,
          justifyContent: computed.justifyContent,
          alignItems: computed.alignItems,
          alignContent: computed.alignContent,
          gap: computed.gap,
          rowGap: computed.rowGap,
          columnGap: computed.columnGap,
          gridTemplateColumns: computed.gridTemplateColumns,
          gridTemplateRows: computed.gridTemplateRows,
          gridAutoColumns: computed.gridAutoColumns,
          gridAutoRows: computed.gridAutoRows,
          gridAutoFlow: computed.gridAutoFlow,
          placeItems: computed.placeItems,
          placeContent: computed.placeContent,
        },
      };
    })
    .filter((snapshot): snapshot is ScrollSnapshot => snapshot !== null);
}

function restoreScrollSnapshotAttributes(node: HTMLElement, snapshots: ScrollSnapshot[]) {
  snapshots.forEach(({ id, restoreAttribute }) => {
    const selector = `[${BUG_REPORT_SCROLL_ATTR}="${id}"]`;
    const element =
      node.matches(selector)
        ? node
        : (node.querySelector<HTMLElement>(selector) ?? null);
    if (!element) {
      return;
    }
    if (restoreAttribute == null) {
      element.removeAttribute(BUG_REPORT_SCROLL_ATTR);
      return;
    }
    element.setAttribute(BUG_REPORT_SCROLL_ATTR, restoreAttribute);
  });
}

function applyScrollSnapshotsToClone(node: HTMLElement, snapshots: ScrollSnapshot[]) {
  snapshots.forEach(({ id, top, left, layout }) => {
    const selector = `[${BUG_REPORT_SCROLL_ATTR}="${id}"]`;
    const element =
      node.matches(selector)
        ? node
        : (node.querySelector<HTMLElement>(selector) ?? null);
    if (!element) {
      return;
    }
    if (top === 0 && left === 0) {
      return;
    }
    const ownerDocument = element.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const wrapper = ownerDocument.createElement("div");
    wrapper.setAttribute(BUG_REPORT_SCROLL_WRAPPER_ATTR, "true");
    const display = layout.display === "inline" ? "block" : layout.display;
    wrapper.style.display = display;
    wrapper.style.flexDirection = layout.flexDirection;
    wrapper.style.flexWrap = layout.flexWrap;
    wrapper.style.justifyContent = layout.justifyContent;
    wrapper.style.alignItems = layout.alignItems;
    wrapper.style.alignContent = layout.alignContent;
    wrapper.style.gap = layout.gap;
    wrapper.style.rowGap = layout.rowGap;
    wrapper.style.columnGap = layout.columnGap;
    wrapper.style.gridTemplateColumns = layout.gridTemplateColumns;
    wrapper.style.gridTemplateRows = layout.gridTemplateRows;
    wrapper.style.gridAutoColumns = layout.gridAutoColumns;
    wrapper.style.gridAutoRows = layout.gridAutoRows;
    wrapper.style.gridAutoFlow = layout.gridAutoFlow;
    wrapper.style.placeItems = layout.placeItems;
    wrapper.style.placeContent = layout.placeContent;
    wrapper.style.position = "relative";
    wrapper.style.boxSizing = "border-box";
    wrapper.style.minWidth = left !== 0 ? `calc(100% + ${left}px)` : "100%";
    wrapper.style.minHeight = top !== 0 ? `calc(100% + ${top}px)` : "100%";
    wrapper.style.transform = `translate(${-left}px, ${-top}px)`;
    wrapper.style.transformOrigin = "top left";

    while (element.firstChild) {
      wrapper.appendChild(element.firstChild);
    }
    element.appendChild(wrapper);
    element.style.overflow = "hidden";
  });
}

async function toPngPreservingScroll(node: HTMLElement, options: HtmlToImageOptions): Promise<string> {
  const [
    { cloneNode },
    { embedWebFonts },
    { embedImages },
    { applyStyle },
    { getImageSize, getPixelRatio, checkCanvasDimensions, nodeToDataURL, createImage },
  ] = await Promise.all([
    import("html-to-image/lib/clone-node"),
    import("html-to-image/lib/embed-webfonts"),
    import("html-to-image/lib/embed-images"),
    import("html-to-image/lib/apply-style"),
    import("html-to-image/lib/util"),
  ]);

  const scrollSnapshots = captureScrollSnapshots(node);
  try {
    const { width, height } = getImageSize(node, options);
    const clonedNode = await cloneNode(node, options, true);
    if (!clonedNode) {
      throw new Error("Unable to clone the current screen for capture.");
    }
    applyScrollSnapshotsToClone(clonedNode, scrollSnapshots);
    try {
      await embedWebFonts(clonedNode, options);
    } catch (error) {
      console.warn("Bug report capture: unable to inline web fonts.", error);
    }
    try {
      await embedImages(clonedNode, options);
    } catch (error) {
      console.warn("Bug report capture: unable to inline one or more images.", error);
    }
    applyStyle(clonedNode, options);

    const svg = await nodeToDataURL(clonedNode, width, height);
    const image = await createImage(svg);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to prepare the screenshot canvas.");
    }
    const pixelRatio = options.pixelRatio || getPixelRatio();
    const canvasWidth = options.canvasWidth || width;
    const canvasHeight = options.canvasHeight || height;

    canvas.width = canvasWidth * pixelRatio;
    canvas.height = canvasHeight * pixelRatio;
    if (!options.skipAutoScale) {
      checkCanvasDimensions(canvas);
    }
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    if (options.backgroundColor) {
      context.fillStyle = options.backgroundColor;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
  } finally {
    restoreScrollSnapshotAttributes(node, scrollSnapshots);
  }
}

export async function captureCurrentScreenBugReportDraft(): Promise<BugReportScreenshotDraft> {
  const node = resolveCaptureNode();
  const backgroundColor = getComputedStyle(document.body).backgroundColor || "#000000";
  const dataUrl = await toPngPreservingScroll(node, {
    cacheBust: true,
    filter: (currentNode) => {
      if (!(currentNode instanceof Element)) {
        return true;
      }
      return currentNode.closest("[data-bug-report-overlay='true']") === null;
    },
    backgroundColor,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    width: window.innerWidth,
    height: window.innerHeight,
    canvasWidth: window.innerWidth,
    canvasHeight: window.innerHeight,
    style: {
      margin: "0",
      width: `${window.innerWidth}px`,
      height: `${window.innerHeight}px`,
      overflow: "hidden",
    },
  });
  return buildBugReportScreenshotDraftFromDataUrl(dataUrl, {
    fileName: buildScreenshotFileName(),
  });
}
