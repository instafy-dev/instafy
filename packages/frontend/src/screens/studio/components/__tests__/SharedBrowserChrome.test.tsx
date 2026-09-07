// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "../../../../components/Button";
import { BrowserExpandButton } from "../BrowserExpandButton";
import {
  normalizeSharedBrowserAddress,
  SharedBrowserChrome,
  type SharedBrowserChromeProps,
} from "../SharedBrowserChrome";
import type { BrowserSessionPage } from "../browserSessionPages";

function page(overrides: Partial<BrowserSessionPage> = {}): BrowserSessionPage {
  return {
    id: "page-1",
    url: "https://example.com/",
    host: "example.com",
    label: "Example",
    title: "Example site",
    lastReferencedAt: 1,
    isActive: true,
    ...overrides,
  };
}

function props(overrides: Partial<SharedBrowserChromeProps> = {}): SharedBrowserChromeProps {
  return {
    pages: [page()],
    resolved: true,
    pendingAction: null,
    error: null,
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onFocusPage: vi.fn(),
    onClearError: vi.fn(),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("normalizeSharedBrowserAddress", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["example.com/path", "https://example.com/path"],
    ["localhost:5173/studio", "https://localhost:5173/studio"],
    ["http://example.com", "http://example.com/"],
    ["  HTTPS://EXAMPLE.COM/path  ", "https://example.com/path"],
    ["about:blank", "about:blank"],
  ])("normalizes %s", (address, expected) => {
    expect(normalizeSharedBrowserAddress(address)).toBe(expected);
  });

  it.each([
    "",
    "javascript:alert(1)",
    "file:///tmp/example",
    "about:config",
    "not a domain",
    "https://user:secret@example.com",
  ])(
    "rejects %s",
    (address) => {
      expect(normalizeSharedBrowserAddress(address)).toBeNull();
    },
  );
});

describe("SharedBrowserChrome", () => {
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

  it("uses the active page for native navigation controls", async () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const onReload = vi.fn();
    const model = props({
      pages: [
        page({ id: "page-1", isActive: false }),
        page({ id: "page-2", url: "https://two.example/", isActive: true }),
      ],
      onBack,
      onForward,
      onReload,
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-back"]')?.click();
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-forward"]')?.click();
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-reload"]')?.click();
    });
    expect(onBack).toHaveBeenCalledWith("page-2");
    expect(onForward).toHaveBeenCalledWith("page-2");
    expect(onReload).toHaveBeenCalledWith("page-2");
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')?.value,
    ).toBe("https://two.example/");
  });

  it("honors live history capabilities when they are available", async () => {
    const model = props({
      pages: [
        {
          ...page(),
          canGoBack: false,
          canGoForward: true,
        },
      ],
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-back"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-forward"]')?.disabled,
    ).toBe(false);
  });

  it("uses the common icon button styling for navigation and expansion", async () => {
    await act(async () => root.render(
      <>
        <IconButton aria-label="Reference" data-testid="reference-icon-button" radius="full" size="sm" variant="ghost" />
        <SharedBrowserChrome {...props()} toolbarActions={<BrowserExpandButton expanded={false} onPress={vi.fn()} />} />
      </>,
    ));
    const reference = container.querySelector<HTMLButtonElement>('[data-testid="reference-icon-button"]')!;
    const allowedClasses = new Set([...reference.classList, "shrink-0", "max-[540px]:h-10", "max-[540px]:w-10"]);
    for (const testId of ["shared-browser-back", "shared-browser-forward", "shared-browser-reload", "browser-session-fullscreen-toggle"]) {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
      for (const token of reference.classList) expect(button.classList.contains(token)).toBe(true);
      expect([...button.classList].filter((token) => !allowedClasses.has(token))).toEqual([]);
      expect(button.classList.contains("pointer-coarse:min-h-11")).toBe(true);
      expect(button.classList.contains("pointer-coarse:min-w-11")).toBe(true);
      expect(button.classList.contains("max-[540px]:h-10")).toBe(true);
      expect(button.title).toBe(button.getAttribute("aria-label"));
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("falls back to the first page and navigates from the in-field Go button", async () => {
    const onNavigate = vi.fn();
    const model = props({
      pages: [page({ id: "fallback", isActive: false })],
      onNavigate,
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));
    const input = container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')!;
    const go = container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-go"]')!;
    expect(go.classList.contains("pointer-coarse:min-h-11")).toBe(true);
    expect(go.classList.contains("pointer-coarse:min-w-11")).toBe(true);

    await act(async () => {
      input.focus();
      setInputValue(input, "instafy.dev/docs");
    });
    await act(async () => {
      go.focus();
    });
    expect(input.value).toBe("instafy.dev/docs");
    await act(async () => go.click());

    expect(onNavigate).toHaveBeenCalledWith("fallback", "https://instafy.dev/docs");
    expect(input.value).toBe("https://instafy.dev/docs");
  });

  it("keeps an in-progress edit while focused and catches up after blur", async () => {
    const model = props();
    await act(async () => root.render(<SharedBrowserChrome {...model} />));
    const input = container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')!;

    await act(async () => {
      input.focus();
      setInputValue(input, "draft.example");
    });
    await act(async () => {
      root.render(
        <SharedBrowserChrome
          {...model}
          pages={[page({ url: "https://updated.example/" })]}
        />,
      );
    });
    expect(input.value).toBe("draft.example");

    await act(async () => input.blur());
    expect(input.value).toBe("https://updated.example/");
  });

  it("shows associated inline errors and clears them when the user edits", async () => {
    const onNavigate = vi.fn();
    const onClearError = vi.fn();
    const model = props({ error: "The shared browser could not navigate.", onClearError, onNavigate });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));
    const input = container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')!;
    const error = container.querySelector<HTMLElement>('[data-testid="shared-browser-error"]')!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);

    await act(async () => {
      input.focus();
      setInputValue(input, "next.example");
    });
    expect(onClearError).toHaveBeenCalledOnce();

    await act(async () => {
      setInputValue(input, "javascript:alert(1)");
      container
        .querySelector<HTMLFormElement>('[data-testid="shared-browser-address-form"]')
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="shared-browser-error"]')?.textContent).toContain(
      "http:// or https://",
    );
  });

  it("restores the loaded page address when navigation fails", async () => {
    const onNavigate = vi.fn();
    const model = props({ onNavigate });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));
    const input = container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')!;
    const form = container.querySelector<HTMLFormElement>('[data-testid="shared-browser-address-form"]')!;

    await act(async () => {
      input.focus();
      setInputValue(input, "failed.example");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe("https://failed.example/");

    await act(async () => {
      root.render(
        <SharedBrowserChrome {...model} error="Navigation failed." />,
      );
    });
    expect(input.value).toBe("https://example.com/");
  });

  it("keeps the page selector available at narrow widths and disables actions while pending", async () => {
    const onFocusPage = vi.fn();
    const model = props({
      compact: true,
      pages: [
        page({ id: "page-1", title: "First", isActive: true }),
        page({ id: "page-2", title: "Second", isActive: false }),
      ],
      pendingAction: "reload",
      onFocusPage,
      toolbarStatus: <span data-testid="shared-browser-test-status">Ready</span>,
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));
    const chrome = container.querySelector<HTMLElement>('[data-testid="shared-browser-chrome"]')!;
    const select = container.querySelector<HTMLSelectElement>('[data-testid="shared-browser-page-select"]')!;
    const address = container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')!;
    expect(chrome.getAttribute("data-browser-session-safe-zone")).toBe("true");
    expect(chrome.getAttribute("aria-busy")).toBe("true");
    expect(chrome.className).toContain("flex-nowrap");
    expect(chrome.className).toContain("overflow-hidden");
    expect(
      container.querySelector('[data-testid="shared-browser-test-status"]')?.parentElement
        ?.className,
    ).not.toBe("sr-only");
    expect(
      container.querySelector('[data-testid="browser-chrome-context-row"]')?.className,
    ).toContain("max-[540px]:basis-full");
    expect(select.className).not.toContain("hidden");
    expect(select.className).toContain("w-10");
    expect(select.title).toBe("First");
    expect(select.disabled).toBe(true);
    expect(address.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-go"]')?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-back"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="shared-browser-pending"]')?.textContent).toContain("reload");
  });

  it("keeps compact navigation touchable without sacrificing the address field", async () => {
    const model = props({
      compact: true,
      pages: [
        page({
          id: "page-1",
          title: "A very long active page title that must not widen the chrome",
          isActive: true,
        }),
        page({ id: "page-2", title: "Second long page title", isActive: false }),
        page({ id: "page-3", title: "Third long page title", isActive: false }),
      ],
      toolbarStatus: <span data-testid="shared-browser-test-status">Agent controls</span>,
      toolbarActions: <button type="button">Request control from a long teammate name</button>,
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));

    expect(
      container.querySelector('[data-testid="shared-browser-reload"]')?.className,
    ).toContain("max-[540px]:h-10");
    expect(
      container.querySelector('[data-testid="shared-browser-address"]')?.className,
    ).toContain("max-[540px]:h-10");
    expect(
      container.querySelector('[data-testid="shared-browser-go"]')?.getAttribute("aria-label"),
    ).toBe("Go");
    expect(
      container.querySelector('[data-testid="shared-browser-page-select"]')?.getAttribute(
        "aria-label",
      ),
    ).toBe("Shared browser tab");
    expect(container.querySelector('[data-testid="browser-chrome-context-row"]')?.textContent)
      .toContain("Agent controls");
  });

  it("renders viewport controls while disabling individually unsupported actions", async () => {
    const model = props({
      controls: { navigate: true, history: false, reload: true, focusPage: false },
      pages: [
        page({ id: "page-1", isActive: true, canGoBack: true }),
        page({ id: "page-2", isActive: false }),
      ],
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-back"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-reload"]')?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLSelectElement>('[data-testid="shared-browser-page-select"]')?.disabled,
    ).toBe(true);
  });

  it("focuses another page from the selector when controls are ready", async () => {
    const onFocusPage = vi.fn();
    const model = props({
      pages: [
        page({ id: "page-1", title: "First", isActive: true }),
        page({ id: "page-2", title: "Second", isActive: false }),
      ],
      onFocusPage,
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));
    const select = container.querySelector<HTMLSelectElement>('[data-testid="shared-browser-page-select"]')!;
    await act(async () => {
      select.value = "page-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFocusPage).toHaveBeenCalledWith("page-2");
  });

  it("locks every human chrome control for the agent and restores them after the turn", async () => {
    const onReload = vi.fn();
    const onNavigate = vi.fn();
    const model = props({
      controls: { navigate: true, history: true, reload: true, focusPage: true },
      pages: [
        page({ id: "page-1", isActive: true, canGoBack: true, canGoForward: true }),
        page({ id: "page-2", isActive: false }),
      ],
      onNavigate,
      onReload,
    });

    await act(async () => {
      root.render(
        <SharedBrowserChrome
          {...model}
          controlOwner={{ kind: "agent", displayName: "Octo" }}
        />,
      );
    });

    expect(container.firstElementChild?.getAttribute("data-control-owner")).toBe("agent");
    for (const testId of [
      "shared-browser-back",
      "shared-browser-forward",
      "shared-browser-reload",
      "shared-browser-go",
    ]) {
      expect(
        container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.disabled,
      ).toBe(true);
    }
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLSelectElement>('[data-testid="shared-browser-page-select"]')?.disabled,
    ).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-reload"]')?.click();
      root.render(<SharedBrowserChrome {...model} controlOwner={{ kind: "human" }} />);
    });
    expect(onReload).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute("data-control-owner")).toBe("human");
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-reload"]')?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')?.disabled,
    ).toBe(false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-reload"]')?.click();
    });
    expect(onReload).toHaveBeenCalledWith("page-1");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("fails closed when this human session does not own the collaboration lease", async () => {
    const model = props({
      pages: [page({ canGoBack: true, canGoForward: true })],
      interactionEnabled: false,
    });
    await act(async () => root.render(<SharedBrowserChrome {...model} />));

    expect(container.firstElementChild?.getAttribute("data-control-owner")).toBe("human");
    expect(container.firstElementChild?.getAttribute("data-interaction-enabled")).toBe("false");
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="shared-browser-address"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-reload"]')?.disabled,
    ).toBe(true);
  });
});
