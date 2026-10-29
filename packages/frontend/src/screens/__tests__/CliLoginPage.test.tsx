// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../../components/RequireAuth";
import { CliLoginPage } from "../CliLoginPage";

type TestUser = { id: string; is_anonymous?: boolean };
type TestSession = { access_token: string; refresh_token: string; user: TestUser };

const auth = vi.hoisted(() => ({
  loading: false,
  session: null as TestSession | null,
  user: null as TestUser | null,
}));

const platform = vi.hoisted(() => ({ native: false }));

// What document.hasFocus() answers: whether the browser window is in front.
const browserWindow = { focused: true };

// The page's own timers are fake, so letting requests settle needs a real one.
const realSetTimeout = globalThis.setTimeout;

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => (platform.native ? "android" : "web"),
  },
}));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../lib/supabaseClient", () => ({
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "publishable-key",
}));

const CALLBACK = "http://127.0.0.1:4000/callback";
// `instafy login`'s state is 16 random bytes in hex, and its code is the first 8
// characters as XXXX-XXXX. packages/instafy-cli/test/login-confirmation-code.spec.ts
// checks the CLI against the same pair.
const STATE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const CODE = "0F1E-2D3C";
// How long the page must be in front before Connect or Copy takes a press.
const READY_AFTER_MS = 750;
// The longest usual gap between the two clicks of a double-click.
const DOUBLE_CLICK_GAP_MS = 500;
// The gap between presses in a fast burst of clicks or Enter presses.
const BURST_GAP_MS = 150;
// How long the page waits for the CLI to answer.
const CALLBACK_TIMEOUT_MS = 4000;

// jsdom has no PointerEvent, so React Aria takes its mouse and touch fallback
// there. A test that installs this one before rendering gets the path real
// browsers take, where a pointer that leaves a button and comes back during a
// press starts the press again.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.width = init.width ?? 1;
    this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0;
  }
}
const MOUSE_POINTER = { pointerId: 1, pointerType: "mouse", width: 1, height: 1, pressure: 0.5 };
const TOUCH_POINTER = { pointerId: 2, pointerType: "touch", width: 20, height: 20, pressure: 0.5 };

function cliLoginAddress({
  cliState = STATE,
  cliCallbackUrl = CALLBACK,
  cliCode = "1",
  serverUrl = "https://controller.instafy.dev",
}: {
  cliState?: string | null;
  cliCallbackUrl?: string;
  cliCode?: string | null;
  serverUrl?: string;
} = {}) {
  const params = new URLSearchParams({ serverUrl, cliCallbackUrl });
  if (cliState !== null) {
    params.set("cliState", cliState);
  }
  if (cliCode !== null) {
    params.set("cliCode", cliCode);
  }
  return `/cli/login?${params.toString()}`;
}

const CLI_LOGIN = cliLoginAddress();
const ACCOUNT_TOKENS = { access: "account-access-token", refresh: "account-refresh-token" };
const ANONYMOUS_TOKENS = { access: "anon-access-token", refresh: "anon-refresh-token" };
const CONNECTED = "Connected. Your terminal continues on its own, and you can close this page.";
const FAILED = "Could not connect to the CLI. Copy the token instead.";
const MOVE_POINTER = "Move the pointer, then click again.";

function signIn(
  user: TestUser,
  tokens: { access: string; refresh: string },
  sessionUser: TestUser = user,
) {
  auth.user = user;
  auth.session = { access_token: tokens.access, refresh_token: tokens.refresh, user: sessionUser };
}

function signOut() {
  auth.user = null;
  auth.session = null;
}

function Destination() {
  const location = useLocation();
  return <p data-testid="destination">{location.pathname}</p>;
}

// The login page sends a signed-in person back to the address RequireAuth saved.
function LoginStub() {
  const location = useLocation();
  const redirect = new URLSearchParams(location.search).get("redirect");
  if (auth.user && redirect) {
    return <Navigate to={redirect} replace />;
  }
  return <p data-testid="login">{location.pathname}</p>;
}

describe("CliLoginPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let clipboardWrite: ReturnType<typeof vi.fn>;

  // Lets pending requests and the state they set settle.
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    });
  };

  const render = async (entry = CLI_LOGIN) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              path="/cli/login"
              element={
                <RequireAuth>
                  <CliLoginPage />
                </RequireAuth>
              }
            />
            <Route path="/login" element={<LoginStub />} />
            <Route path="/studio" element={<Destination />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await settle();
  };

  // Time passing on the page's clock.
  const wait = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };
  const movePointer = async () => {
    await act(async () => {
      document.body.dispatchEvent(new Event("pointermove", { bubbles: true }));
    });
  };
  // The page has been in front for long enough, and the pointer has moved over it.
  const ready = async () => {
    await movePointer();
    await wait(READY_AFTER_MS);
  };
  const blurWindow = async () => {
    browserWindow.focused = false;
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
  };
  const focusWindow = async () => {
    browserWindow.focused = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
  };
  const setVisibility = async (state: "visible" | "hidden") => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  const find = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const connectButton = () => find("cli-login-connect") as HTMLButtonElement | null;
  const copyButton = () => container.querySelector('[aria-label="Copy token"]') as HTMLButtonElement | null;
  const serverLine = () =>
    Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.startsWith("Server:")) ?? null;

  // A press as the keyboard or a screen reader makes it (element.click()).
  const press = async (button: HTMLElement | null) => {
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    await settle();
  };
  // One step of a mouse press, as a real pointer makes it.
  const mouse = async (type: "mousedown" | "mouseup" | "click", button: HTMLElement | null) => {
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });
  };
  // A mouse click: down, up and click.
  const click = async (button: HTMLElement | null) => {
    await mouse("mousedown", button);
    await mouse("mouseup", button);
    await mouse("click", button);
    await settle();
  };
  // One step of an Enter press on the button.
  const enterKey = async (type: "keydown" | "keyup", button: HTMLElement | null) => {
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true }));
    });
  };
  const enter = async (button: HTMLElement | null) => {
    await enterKey("keydown", button);
    await enterKey("keyup", button);
    await settle();
  };
  // One step of a press where pointer events exist (TestPointerEvent).
  const pointer = async (type: string, button: HTMLElement | null, init: PointerEventInit) => {
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new TestPointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
    });
  };
  const pressEveryButton = async () => {
    for (const button of Array.from(container.querySelectorAll("button"))) {
      if (button.isConnected) {
        await act(async () => button.click());
      }
    }
    await settle();
  };

  const sentBodies = () =>
    fetchMock.mock.calls.map(([, init]) => new URLSearchParams(String((init as RequestInit).body)));

  const expectOneSend = (tokens: { access: string; refresh: string }) => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CALLBACK);
    expect(init.method).toBe("POST");
    const [body] = sentBodies();
    expect(body.get("token")).toBe(tokens.access);
    expect(body.get("refreshToken")).toBe(tokens.refresh);
    expect(body.get("state")).toBe(STATE);
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    signOut();
    platform.native = false;
    browserWindow.focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => browserWindow.focused);
    fetchMock = vi.fn(async () => ({ ok: true, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    clipboardWrite = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboardWrite } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["false", { id: "user-1", is_anonymous: false }],
    ["absent", { id: "user-1" }],
  ])("sends an account's session only when Connect is pressed (is_anonymous %s)", async (_label, user) => {
    signIn(user, ACCOUNT_TOKENS);
    await render();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("h1")?.textContent).toBe("Signed in to Instafy");
    expect(find("cli-login-confirmation-code")?.textContent).toBe(CODE);
    expect(container.textContent).toContain(
      "Press Connect only if you just ran instafy login and your terminal shows this code.",
    );
    expect(connectButton()?.textContent).toBe("Connect the CLI");

    // A refreshed session renders the page again and still sends nothing.
    signIn(user, ACCOUNT_TOKENS);
    await render();
    await ready();
    expect(fetchMock).not.toHaveBeenCalled();

    await click(connectButton());

    expectOneSend(ACCOUNT_TOKENS);
    expect(find("cli-login-status")?.textContent).toBe(CONNECTED);
    expect(connectButton()).toBeNull();
    expect(container.textContent).not.toContain("Connecting to the CLI");
  });

  it("cannot send twice while a send is on its way", async () => {
    let answer: (response: { ok: boolean; text: () => Promise<string> }) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    await press(connectButton());
    expect(find("cli-login-status")?.textContent).toBe("Connecting to the CLI…");
    expect(connectButton()?.getAttribute("aria-disabled")).toBe("true");

    await press(connectButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => answer({ ok: true, text: async () => "" }));
    await settle();

    expectOneSend(ACCOUNT_TOKENS);
    expect(find("cli-login-status")?.textContent).toBe(CONNECTED);
  });

  it.each([
    [
      "cannot be reached",
      () => {
        fetchMock.mockImplementation(async () => {
          throw new TypeError("Failed to fetch");
        });
      },
      "Could not connect to the CLI callback.",
    ],
    [
      "refuses the sign-in",
      () => {
        fetchMock.mockImplementation(async () => ({
          ok: false,
          text: async () => '{"ok":false,"error":"Invalid state"}',
        }));
      },
      "Invalid state",
    ],
    [
      "has already finished",
      () => {
        fetchMock.mockImplementation(async () => ({
          ok: false,
          text: async () => '{"ok":false,"error":"Already completed"}',
        }));
      },
      "Already completed",
    ],
  ])("offers the token to copy, and sends it nowhere else, when the CLI %s", async (_label, failCallback, detail) => {
    failCallback();
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();
    expect(fetchMock).not.toHaveBeenCalled();

    await click(connectButton());

    // Only the address the CLI printed: another host on its port could be someone else.
    expectOneSend(ACCOUNT_TOKENS);
    expect(find("cli-login-status")?.textContent).toBe(FAILED);
    expect(container.textContent).toContain(detail);
    expect(copyButton()).not.toBeNull();
    expect(container.textContent).not.toContain(CONNECTED);
  });

  it("gives up on a CLI that does not answer, and sends the sign-in nowhere else", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    await click(connectButton());
    expect(find("cli-login-status")?.textContent).toBe("Connecting to the CLI…");

    await wait(CALLBACK_TIMEOUT_MS);
    await settle();

    expectOneSend(ACCOUNT_TOKENS);
    expect(find("cli-login-status")?.textContent).toBe(FAILED);
    expect(container.textContent).toContain("Timed out connecting to the CLI callback.");
  });

  it("sends the sign-in nowhere else when the CLI's address answers with a redirect", async () => {
    // What fetch does with a 307 from the callback: it sends the same POST, body
    // and all, to the address the answer names, unless the page asks it to fail.
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url !== CALLBACK) {
        return { ok: true, text: async () => "" };
      }
      if (init.redirect === "error") {
        throw new TypeError("Failed to fetch");
      }
      return fetch("http://elsewhere.example/collect", init);
    });
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    await click(connectButton());

    expectOneSend(ACCOUNT_TOKENS);
    expect(find("cli-login-status")?.textContent).toBe(FAILED);
    expect(container.textContent).not.toContain(CONNECTED);
  });

  it.each([
    ["a made-up word", "state-1"],
    ["uppercase hex", STATE.toUpperCase()],
    ["one character short", STATE.slice(0, 31)],
    ["one character long", `${STATE}0`],
    ["a character outside hex", `${STATE.slice(0, 31)}g`],
    ["surrounding space", ` ${STATE} `],
    ["an empty value", ""],
    ["no value", null],
  ])("offers no callback for a state the CLI does not make (%s)", async (_label, cliState) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render(cliLoginAddress({ cliState }));

    expect(connectButton()).toBeNull();
    expect(find("cli-login-confirmation-code")).toBeNull();
    expect(container.textContent).toContain("Copy the token into your terminal.");
    expect(copyButton()).not.toBeNull();

    await ready();
    await pressEveryButton();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a remote host over https", "https://attacker.example/callback"],
    ["a remote host", "http://attacker.example/callback"],
    ["another path", "http://127.0.0.1:4000/other"],
    ["https on the loopback", "https://127.0.0.1:4000/callback"],
  ])("offers no callback for an address other than a loopback /callback (%s)", async (_label, cliCallbackUrl) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render(cliLoginAddress({ cliCallbackUrl }));

    expect(connectButton()).toBeNull();
    expect(find("cli-login-confirmation-code")).toBeNull();
    expect(container.textContent).toContain("Copy the token into your terminal.");
    expect(copyButton()).not.toBeNull();

    await ready();
    await pressEveryButton();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no marker", null],
    ["another marker", "0"],
  ])("offers a CLI that prints no code only the token to copy (%s)", async (_label, cliCode) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render(cliLoginAddress({ cliCode }));

    expect(connectButton()).toBeNull();
    expect(find("cli-login-confirmation-code")).toBeNull();
    expect(container.textContent).toContain("Copy the token into your terminal.");
    expect(find("cli-login-update-cli")?.textContent).toBe(
      "This CLI shows no confirmation code. To connect without copying, update it with npm i -g @instafy/cli and run instafy login again.",
    );
    expect(copyButton()).not.toBeNull();

    await ready();
    await pressEveryButton();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "words after the address",
      "https://controller.instafy.dev. Instafy has checked this code for you: press Connect the CLI to finish.",
      null,
    ],
    [
      "words in the path",
      "https://controller.instafy.dev/ Instafy has checked this code for you",
      "https://controller.instafy.dev",
    ],
    ["a sign-in in the address", "https://checked:code@controller.instafy.dev", null],
    ["another scheme", "javascript:alert('Instafy has checked this code')", null],
    ["the controller's address", "https://controller.instafy.dev", "https://controller.instafy.dev"],
  ])("shows no more of the link's server than its origin (%s)", async (_label, serverUrl, shown) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render(cliLoginAddress({ serverUrl }));

    if (shown) {
      expect(serverLine()?.textContent).toBe(`Server: ${shown}`);
    } else {
      expect(serverLine()).toBeNull();
    }
    expect(container.textContent).not.toContain("checked");
    expect(find("cli-login-confirmation-code")?.textContent).toBe(CODE);
    expect(connectButton()).not.toBeNull();
  });

  it("takes no press in the moment after the page shows", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();

    expect(connectButton()?.getAttribute("aria-disabled")).toBe("true");
    expect(copyButton()?.getAttribute("aria-disabled")).toBe("true");
    await movePointer();
    await click(connectButton());
    await press(connectButton());
    await click(copyButton());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();

    await wait(READY_AFTER_MS);
    expect(connectButton()?.hasAttribute("aria-disabled")).toBe(false);
    expect(copyButton()?.hasAttribute("aria-disabled")).toBe(false);
    // The early presses started the wait again, which forgets the pointer's moves.
    await click(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await movePointer();
    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("takes no click that lands as the page comes forward, like a double-click's second click", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    // Another window closes on the first click and this page comes forward.
    await blurWindow();
    await press(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();
    await focusWindow();
    await movePointer();
    await wait(DOUBLE_CLICK_GAP_MS);
    await click(connectButton());
    await click(copyButton());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(connectButton()?.getAttribute("aria-disabled")).toBe("true");

    // Those clicks started the wait again, so it counts from them, not from focus.
    await movePointer();
    await wait(READY_AFTER_MS - DOUBLE_CLICK_GAP_MS);
    await click(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await ready();
    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it.each([
    ["Connect", () => connectButton(), () => expectOneSend(ACCOUNT_TOKENS)],
    ["Copy", () => copyButton(), () => expect(clipboardWrite).toHaveBeenCalledWith(ACCOUNT_TOKENS.access)],
  ])("takes no mouse press on %s that starts during the wait, however long it is held", async (_label, button, taken) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();

    // A "click, then press and hold" lure's second press, landing as this page
    // comes forward and held past the wait, with the pointer moving meanwhile.
    await movePointer();
    await mouse("mousedown", button());
    await movePointer();
    await wait(READY_AFTER_MS * 2);
    expect(button()?.hasAttribute("aria-disabled")).toBe(false);
    await mouse("mouseup", button());
    await mouse("click", button());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();

    // A press that starts after the wait is taken.
    await click(button());
    taken();
  });

  it("takes no Enter press that starts during the wait, however long it is held", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await act(async () => connectButton()?.focus());

    await enterKey("keydown", connectButton());
    await wait(READY_AFTER_MS * 2);
    await enterKey("keyup", connectButton());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await enter(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("takes no touch that starts during the wait, however long it is held, where pointer events exist", async () => {
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();

    await pointer("pointerdown", connectButton(), TOUCH_POINTER);
    await wait(READY_AFTER_MS * 2);
    await pointer("pointerup", connectButton(), TOUCH_POINTER);
    await pointer("click", connectButton(), { ...TOUCH_POINTER, detail: 1 });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    // A touch needs no pointer movement, only the wait before it starts.
    await pointer("pointerdown", connectButton(), TOUCH_POINTER);
    await pointer("pointerup", connectButton(), TOUCH_POINTER);
    await pointer("click", connectButton(), { ...TOUCH_POINTER, detail: 1 });
    await settle();
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("still refuses a press that started during the wait when the pointer leaves Connect and comes back", async () => {
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();

    // Held from the moment the page shows, slid off Connect and back on once the
    // wait has passed, which starts the press again, and released there.
    await pointer("pointerdown", connectButton(), MOUSE_POINTER);
    await pointer("pointerout", connectButton(), { ...MOUSE_POINTER, relatedTarget: document.body });
    await movePointer();
    await wait(READY_AFTER_MS * 2);
    await pointer("pointerover", connectButton(), { ...MOUSE_POINTER, relatedTarget: document.body });
    await pointer("pointerup", connectButton(), MOUSE_POINTER);
    await pointer("click", connectButton(), { ...MOUSE_POINTER, detail: 1 });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await pointer("pointerdown", connectButton(), MOUSE_POINTER);
    await pointer("pointerup", connectButton(), MOUSE_POINTER);
    await pointer("click", connectButton(), { ...MOUSE_POINTER, detail: 1 });
    await settle();
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("keeps refusing a press held on Connect through a press on Copy", async () => {
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();

    // A press held on Connect from the moment the page shows, slid off it.
    await pointer("pointerdown", connectButton(), MOUSE_POINTER);
    await pointer("pointerout", connectButton(), { ...MOUSE_POINTER, relatedTarget: document.body });
    await movePointer();
    await wait(READY_AFTER_MS * 2);
    // Copy's press starts after the wait, and it is Copy's own.
    await act(async () => copyButton()?.focus());
    await enter(copyButton());
    await pointer("pointerover", connectButton(), { ...MOUSE_POINTER, relatedTarget: document.body });
    await pointer("pointerup", connectButton(), MOUSE_POINTER);
    await pointer("click", connectButton(), { ...MOUSE_POINTER, detail: 1 });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clipboardWrite).toHaveBeenCalledWith(ACCOUNT_TOKENS.access);
  });

  it.each([
    [
      "clicks",
      async () => {
        await movePointer();
        await click(connectButton());
      },
    ],
    ["Enter presses", async () => enter(connectButton())],
  ])("starts the wait again on each press that comes too early, so a burst of %s gets nothing", async (_label, pressOnce) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await act(async () => connectButton()?.focus());

    for (let elapsed = 0; elapsed < READY_AFTER_MS * 2; elapsed += BURST_GAP_MS) {
      await pressOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      await wait(BURST_GAP_MS);
    }
    expect(connectButton()?.getAttribute("aria-disabled")).toBe("true");

    // Once the presses stop for the length of the wait, the next one is taken.
    await ready();
    await pressOnce();
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("takes a mouse click only once the pointer has moved over the page", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await wait(READY_AFTER_MS);

    await click(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await movePointer();
    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  // The line under a button that says to move the pointer, and whether it shows.
  // Hidden, it keeps its room where a mouse may be and takes none elsewhere.
  const moveCue = (button: "connect" | "copy") => find(`cli-login-move-pointer-${button}`);
  // What a screen reader hears about the pointer. It never reads the lines; the
  // page's move-pointer status region says the hint while one of them shows.
  const moveStatus = () => find("cli-login-move-pointer-status");
  const heard = () => moveStatus()?.textContent;
  const showing = (element: HTMLElement | null) =>
    element !== null && !element.classList.contains("invisible");
  const shown = (element: HTMLElement | null) => {
    expect(element).not.toBeNull();
    const classes = element?.classList;
    const hidden = classes?.contains("invisible") ?? false;
    expect(classes?.contains("hidden")).toBe(hidden);
    expect(classes?.contains("any-pointer-fine:block")).toBe(hidden);
    expect(element?.getAttribute("aria-hidden")).toBe("true");
    expect(heard()).toBe(
      showing(moveCue("connect")) || showing(moveCue("copy")) ? MOVE_POINTER : "",
    );
    return !hidden;
  };
  // Each line has a line of its own under its button, so it takes no width from
  // the token or the buttons.
  const expectLinesUnderTheirButtons = () => {
    expect(moveCue("connect")?.previousElementSibling).toBe(connectButton());
    const tokenRow = copyButton()?.parentElement?.parentElement;
    expect(tokenRow?.children).toHaveLength(2);
    expect(tokenRow?.contains(moveCue("copy"))).toBe(false);
    expect(moveCue("copy")?.parentElement).toBe(tokenRow?.parentElement);
  };

  it.each([
    [
      "Connect",
      "a click during the wait",
      "connect",
      () => connectButton(),
      async () => {
        await movePointer();
        await click(connectButton());
      },
      () => {
        expectOneSend(ACCOUNT_TOKENS);
        expect(connectButton()).toBeNull();
        expect(moveCue("connect")).toBeNull();
      },
    ],
    [
      "Copy",
      "a click during the wait",
      "copy",
      () => copyButton(),
      async () => {
        await movePointer();
        await click(copyButton());
      },
      () => {
        expect(clipboardWrite).toHaveBeenCalledWith(ACCOUNT_TOKENS.access);
        expect(shown(moveCue("copy"))).toBe(false);
      },
    ],
    [
      "Connect",
      "the window came forward",
      "connect",
      () => connectButton(),
      async () => {
        await ready();
        await blurWindow();
        await movePointer();
        await focusWindow();
      },
      () => {
        expectOneSend(ACCOUNT_TOKENS);
        expect(connectButton()).toBeNull();
        expect(moveCue("connect")).toBeNull();
      },
    ],
  ] as const)(
    "says to move the pointer when a ready %s refuses a click from a pointer at rest since %s",
    async (_label, _since, which, button, startWaitAgain, taken) => {
      signIn({ id: "user-1" }, ACCOUNT_TOKENS);
      await render();
      // The lines are laid out from the start, hidden, so that showing one takes
      // no new room: on this centered page that would move the buttons.
      const cue = moveCue(which);
      const otherCue = moveCue(which === "connect" ? "copy" : "connect");
      expect(cue?.textContent).toBe(MOVE_POINTER);
      expect(otherCue?.textContent).toBe(MOVE_POINTER);
      expectLinesUnderTheirButtons();
      // The status region is there from the start, so the hint is a change in it.
      const status = moveStatus();
      expect(status?.getAttribute("role")).toBe("status");
      expect(heard()).toBe("");
      await startWaitAgain();
      await wait(READY_AFTER_MS);
      expect(button()?.hasAttribute("aria-disabled")).toBe(false);
      expect(shown(cue)).toBe(false);

      // Clicks with the pointer resting where it was, as with tap-to-click. The
      // button looks ready, so the page says why they do nothing.
      await click(button());
      await click(button());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(clipboardWrite).not.toHaveBeenCalled();
      expect(moveCue(which)).toBe(cue);
      expect(shown(cue)).toBe(true);
      expect(shown(otherCue)).toBe(false);
      expectLinesUnderTheirButtons();
      expect(moveStatus()).toBe(status);
      expect(heard()).toBe(MOVE_POINTER);
      expect(find("cli-login-status-region")?.textContent).toBe("");

      await movePointer();
      await click(button());
      taken();
      expect(heard()).toBe("");
    },
  );

  it("says the hint again when it moves to the other button without the pointer moving", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await wait(READY_AFTER_MS);
    // What the status region holds: a screen reader says each line added to it.
    const said = () => moveStatus()?.firstElementChild ?? null;

    // Connect refuses, then Copy, then Connect again, and the pointer never moves,
    // as when the page scrolls under it. The words are the same each time, so the
    // region must add the hint anew for each button, or the move is never heard.
    await click(connectButton());
    expect(shown(moveCue("connect"))).toBe(true);
    const forConnect = said();
    expect(forConnect?.textContent).toBe(MOVE_POINTER);

    await click(copyButton());
    expect(shown(moveCue("connect"))).toBe(false);
    expect(shown(moveCue("copy"))).toBe(true);
    const forCopy = said();
    expect(forCopy?.textContent).toBe(MOVE_POINTER);
    expect(forCopy).not.toBe(forConnect);
    expect(forConnect?.isConnected).toBe(false);

    await click(connectButton());
    expect(shown(moveCue("copy"))).toBe(false);
    expect(shown(moveCue("connect"))).toBe(true);
    const forConnectAgain = said();
    expect(forConnectAgain?.textContent).toBe(MOVE_POINTER);
    expect(forConnectAgain).not.toBe(forCopy);

    // Another refusal on the same button changes nothing anyone could see or
    // hear, and neither does the page rendering again, as when the session
    // refreshes.
    await click(connectButton());
    expect(said()).toBe(forConnectAgain);
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    expect(shown(moveCue("connect"))).toBe(true);
    expect(said()).toBe(forConnectAgain);
    expect(moveStatus()?.childNodes).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("hides the line under Connect once it takes a click, even when the send fails", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      text: async () => '{"ok":false,"error":"Invalid state"}',
    }));
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await wait(READY_AFTER_MS);
    await click(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown(moveCue("connect"))).toBe(true);

    await movePointer();
    await click(connectButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(find("cli-login-status-region")?.textContent).toContain(FAILED);
    expect(connectButton()).not.toBeNull();
    expect(shown(moveCue("connect"))).toBe(false);
  });

  it.each([
    ["the window goes behind", () => blurWindow()],
    ["the page is hidden", () => setVisibility("hidden")],
  ])("hides the line again when %s and the wait starts again", async (_label, startWaitAgain) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await wait(READY_AFTER_MS);
    await click(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown(moveCue("connect"))).toBe(true);

    await startWaitAgain();
    expect(connectButton()?.getAttribute("aria-disabled")).toBe("true");
    expect(shown(moveCue("connect"))).toBe(false);
  });

  it("says nothing about the pointer when an Enter press that started during the wait is refused", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await act(async () => connectButton()?.focus());
    await enterKey("keydown", connectButton());
    await wait(READY_AFTER_MS * 2);
    await enterKey("keyup", connectButton());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectButton()?.hasAttribute("aria-disabled")).toBe(false);
    expect(shown(moveCue("connect"))).toBe(false);
    expect(shown(moveCue("copy"))).toBe(false);
  });

  it("says nothing about the pointer when a touch that started during the wait is refused", async () => {
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await pointer("pointerdown", connectButton(), TOUCH_POINTER);
    await wait(READY_AFTER_MS * 2);
    await pointer("pointerup", connectButton(), TOUCH_POINTER);
    await pointer("click", connectButton(), { ...TOUCH_POINTER, detail: 1 });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectButton()?.hasAttribute("aria-disabled")).toBe(false);
    expect(shown(moveCue("connect"))).toBe(false);
  });

  it.each([
    ["Copy", () => copyButton(), () => expect(clipboardWrite).toHaveBeenCalledTimes(1)],
    ["Connect", () => connectButton(), () => expectOneSend(ACCOUNT_TOKENS)],
  ] as const)("hides the line under Copy once %s takes an Enter press", async (_label, button, taken) => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await wait(READY_AFTER_MS);
    await click(copyButton());
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(shown(moveCue("copy"))).toBe(true);

    await act(async () => button()?.focus());
    await enter(button());
    taken();
    expect(shown(moveCue("copy"))).toBe(false);
  });

  it("takes a keyboard or screen reader press after the wait, with no pointer", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await wait(READY_AFTER_MS);

    await press(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("waits while the browser window is not in front", async () => {
    browserWindow.focused = false;
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await movePointer();
    await wait(READY_AFTER_MS * 4);

    await click(connectButton());
    await press(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectButton()?.getAttribute("aria-disabled")).toBe("true");

    await focusWindow();
    await ready();
    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("starts the wait again when the page was hidden", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    await setVisibility("hidden");
    await press(connectButton());
    await setVisibility("visible");
    await press(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await ready();
    await press(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("copies the token only after the wait", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();

    await click(copyButton());
    expect(clipboardWrite).not.toHaveBeenCalled();

    await ready();
    await click(copyButton());
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledWith(ACCOUNT_TOKENS.access);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says what Connect did where a screen reader hears it, and keeps focus on the page", async () => {
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    const region = find("cli-login-status-region");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");

    await act(async () => connectButton()?.focus());
    await press(connectButton());

    expect(connectButton()).toBeNull();
    expect(find("cli-login-status-region")).toBe(region);
    expect(region?.textContent).toBe(CONNECTED);
    expect(document.activeElement).toBe(region);
  });

  it("says why Connect failed where a screen reader hears it, and keeps focus on Connect", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      text: async () => '{"ok":false,"error":"Invalid state"}',
    }));
    signIn({ id: "user-1" }, ACCOUNT_TOKENS);
    await render();
    await ready();

    const connect = connectButton();
    await act(async () => connect?.focus());
    await press(connect);

    const region = find("cli-login-status-region");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toContain(FAILED);
    expect(region?.textContent).toContain("Invalid state");
    expect(document.activeElement).toBe(connect);
  });

  it.each([
    ["the session's user", { id: "anon-1" }, { id: "anon-1", is_anonymous: true }],
    ["the provider's user", { id: "anon-1", is_anonymous: true }, { id: "anon-1" }],
  ])("never sends an anonymous session to the CLI (flag on %s)", async (_label, user, sessionUser) => {
    signIn(user, ANONYMOUS_TOKENS, sessionUser);
    await render();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("h1")?.textContent).toBe("The Instafy CLI needs an account");
    expect(container.textContent).toContain("Create one, then run instafy login.");
    expect(connectButton()).toBeNull();
    expect(find("cli-login-confirmation-code")).toBeNull();
    expect(copyButton()).toBeNull();
    expect(container.textContent).not.toContain("anon-");

    await ready();
    await pressEveryButton();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an anonymous session no token to copy", async () => {
    signIn({ id: "anon-1", is_anonymous: true }, ANONYMOUS_TOKENS);
    await render("/cli/login");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(copyButton()).toBeNull();
    expect(container.textContent).not.toContain("anon-");
    expect(find("cli-login-account-required")).not.toBeNull();
  });

  it("sends an anonymous session to the Studio to create its account", async () => {
    signIn({ id: "anon-1", is_anonymous: true }, ANONYMOUS_TOKENS);
    await render();

    const create = find("cli-login-create-account");
    expect(create?.textContent).toBe("Create an account");
    await press(create);

    expect(find("destination")?.textContent).toBe("/studio");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["the same user claims an account", { id: "user-1", is_anonymous: false }],
    ["another account signs in", { id: "user-2", is_anonymous: false }],
  ])("waits for a press after %s while the page is open", async (_label, account) => {
    signIn({ id: "user-1", is_anonymous: true }, ANONYMOUS_TOKENS);
    await render();
    await ready();
    expect(find("cli-login-account-required")).not.toBeNull();

    signIn(account, ACCOUNT_TOKENS);
    await render();

    expect(find("cli-login-account-required")).toBeNull();
    expect(find("cli-login-confirmation-code")?.textContent).toBe(CODE);
    expect(connectButton()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // Connect has just appeared, so it waits like a page that has just opened.
    await click(connectButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await ready();
    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("waits for a press after signing out and back in with an account", async () => {
    signIn({ id: "anon-1", is_anonymous: true }, ANONYMOUS_TOKENS);
    await render();
    expect(find("cli-login-account-required")).not.toBeNull();

    // RequireAuth unmounts the page on sign-out and mounts it again after
    // sign-in, so nothing the page held survives.
    signOut();
    await render();
    expect(find("login")?.textContent).toBe("/login");

    signIn({ id: "user-2", is_anonymous: false }, ACCOUNT_TOKENS);
    await render();

    expect(find("cli-login-confirmation-code")?.textContent).toBe(CODE);
    expect(connectButton()).not.toBeNull();
    await ready();
    expect(fetchMock).not.toHaveBeenCalled();

    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("waits for a press when the page opens again with an account", async () => {
    signIn({ id: "user-1", is_anonymous: true }, ANONYMOUS_TOKENS);
    await render();
    expect(find("cli-login-account-required")).not.toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    signIn({ id: "user-1", is_anonymous: false }, ACCOUNT_TOKENS);
    await render();

    expect(connectButton()).not.toBeNull();
    await ready();
    expect(fetchMock).not.toHaveBeenCalled();

    await click(connectButton());
    expectOneSend(ACCOUNT_TOKENS);
  });

  it("refuses again when the session turns anonymous while the page is open", async () => {
    signIn({ id: "user-1", is_anonymous: false }, ACCOUNT_TOKENS);
    await render();
    await ready();
    expect(connectButton()).not.toBeNull();

    signIn({ id: "anon-1", is_anonymous: true }, ANONYMOUS_TOKENS);
    await render();
    expect(find("cli-login-account-required")).not.toBeNull();
    expect(connectButton()).toBeNull();
    expect(copyButton()).toBeNull();

    signIn({ id: "user-1", is_anonymous: false }, ACCOUNT_TOKENS);
    await render();
    expect(connectButton()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "inside the desktop app",
      () => {
        (window as { instafyDesktop?: unknown }).instafyDesktop = {};
      },
    ],
    [
      "inside the mobile app",
      () => {
        platform.native = true;
      },
    ],
    [
      "in a frame",
      () => {
        vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
      },
    ],
  ])("sends an account's session nowhere and shows no token %s", async (_label, place) => {
    place();
    signIn({ id: "user-1", is_anonymous: false }, ACCOUNT_TOKENS);
    await render();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(find("cli-login-browser-required")).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to the CLI from a browser");
    expect(container.textContent).toContain(
      "Open the link instafy login prints in your web browser.",
    );
    expect(connectButton()).toBeNull();
    expect(find("cli-login-confirmation-code")).toBeNull();
    expect(copyButton()).toBeNull();
    expect(container.textContent).not.toContain("account-");

    await ready();
    await pressEveryButton();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the person back to Studio from inside the app", async () => {
    (window as { instafyDesktop?: unknown }).instafyDesktop = {};
    signIn({ id: "user-1", is_anonymous: false }, ACCOUNT_TOKENS);
    await render();

    const back = find("cli-login-back-to-studio");
    expect(back?.textContent).toBe("Back to Studio");
    await press(back);

    expect(find("destination")?.textContent).toBe("/studio");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
