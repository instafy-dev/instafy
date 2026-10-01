// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAddressField } from "../BrowserAddressField";
import { BrowserToolsOverlayContext } from "../BrowserToolsPopover";

const { clear, history } = vi.hoisted(() => ({
  clear: vi.fn(),
  history: [
    { url: "https://en.wikipedia.org/wiki/Sea", title: "Sea - Encyclopedia", lastVisitedAt: 3 },
    { url: "https://www.bbc.com/news", title: "BBC News", lastVisitedAt: 2 },
    { url: "https://shop.example/cart", title: "Shopping cart", lastVisitedAt: 1 },
  ],
}));
vi.mock("../browserAddressHistory", () => ({ useBrowserAddressHistory: () => ({ entries: history, clear }) }));

let root: Root;
let container: HTMLDivElement;
const inputRef = createRef<HTMLInputElement>();
const navigate = vi.fn();
const submit = vi.fn();
const released = vi.fn();
const registerOverlay = vi.fn(() => released);
function Fixture({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return <BrowserToolsOverlayContext.Provider value={registerOverlay}>
    <BrowserAddressField ref={inputRef} value={value} disabled={disabled} testIdPrefix="test-browser"
      onValueChange={setValue} onNavigateSuggestion={navigate}
      onSubmit={event => { event.preventDefault(); submit(value); }} />
    <button>Outside</button>
  </BrowserToolsOverlayContext.Provider>;
}
const input = () => inputRef.current!;
async function type(value: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(key: string, isComposing = false) {
  await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key, isComposing, bubbles: true, cancelable: true })));
}
const options = () => [...document.querySelectorAll('[role="option"]')];

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { ...CSS, escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`) });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("BrowserAddressField", () => {
  it("has one native input/form and shows recent sites on empty focus without taking input focus", async () => {
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelector("label")!.control).toBe(input());
    await act(async () => input().focus());
    expect(options()).toHaveLength(3);
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(registerOverlay).toHaveBeenCalledOnce();
  });

  it("filters titles and addresses and returns to recent sites when cleared", async () => {
    await type("ENCYCLOPEDIA");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("wikipedia.org");
    await type("bbc.com");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("BBC News");
    await type("");
    expect(options()).toHaveLength(3);
  });

  it("navigates the arrow-selected suggestion once on Enter", async () => {
    await type("bbc");
    await key("ArrowDown");
    await key("Enter");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://www.bbc.com/news");
    expect(submit).not.toHaveBeenCalled();
  });

  it("navigates from an assistive-technology click without pointer events", async () => {
    await type("bbc");
    await act(async () => (options()[0] as HTMLElement).click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://www.bbc.com/news");
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits typed text when no suggestion is selected even with matching options open", async () => {
    await type("bbc.com");
    expect(options()).toHaveLength(1);
    await key("Enter");
    expect(submit).toHaveBeenCalledExactlyOnceWith("bbc.com");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate on Tab, Escape or composition confirmation", async () => {
    await type("bbc");
    await key("ArrowDown");
    await key("Tab");
    expect(navigate).not.toHaveBeenCalled();
    await type("Sea");
    await key("Enter", true);
    expect(navigate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await key("Escape");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(released).toHaveBeenCalled();
  });

  it("closes suggestions when cleared and releases the native overlay", async () => {
    await type("");
    const button = [...document.querySelectorAll("button")].find(el => el.textContent === "Clear recent sites")!;
    await act(async () => button.click());
    expect(clear).toHaveBeenCalledOnce();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(released).toHaveBeenCalled();
  });

  it("disables both navigation entry points and closes an open list when authority is lost", async () => {
    await type("");
    await act(async () => root.render(<Fixture disabled />));
    expect(input().disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Go"]')!.disabled).toBe(true);
    expect(options()).toHaveLength(0);
    expect(released).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
