import { Capacitor } from "@capacitor/core";
import { Copy } from "iconoir-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PressEvent } from "react-aria-components";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, IconButton } from "../components/Button";
import { Heading } from "../components/Heading";
import { Text } from "../components/Text";
import { useAuth } from "../providers/AuthProvider";
import { isDesktopShell } from "../lib/desktopShell";
import { supabaseAnonKey, supabaseUrl } from "../lib/supabaseClient";

function maskToken(token: string): string {
  if (token.length <= 12) {
    return "•".repeat(Math.max(6, token.length));
  }
  return `${token.slice(0, 6)}…${token.slice(-6)}`;
}

// The page sends only to this exact address, never to another host on the same
// port: the CLI listens on 127.0.0.1 alone, so a second host such as localhost,
// which browsers often try as ::1 first, can reach whoever else holds that port.
function normalizeCliCallbackUrl(raw: string | null): URL | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    if (!allowedHosts.has(host)) {
      return null;
    }
    if (parsed.pathname !== "/callback") {
      return null;
    }
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

// The controller the CLI names, shown as its origin only. Anyone who makes a
// link can write the rest of the address, and the page shows no text a link
// wrote beside the code and Connect.
function serverOrigin(raw: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

// `instafy login` names each request with 16 random bytes in hex. A state of
// any other shape did not come from the CLI, so the page offers no callback.
const CLI_STATE_PATTERN = /^[0-9a-f]{32}$/;

// A CLI that prints the confirmation code adds cliCode=1 to this address. An
// older CLI prints none, so the page offers it only the token to copy: Connect
// is safe only when the person can compare the code.
const CLI_CODE_MARKER = "1";

// The code `instafy login` prints beside this page's address
// (cliLoginConfirmationCode in packages/instafy-cli/src/auth.ts): the state's
// first 8 characters, uppercased, as XXXX-XXXX.
function confirmationCode(state: string): string {
  const head = state.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4)}`;
}

// How long the page must have been visible and focused before Connect or Copy
// takes a press.
const PRESS_READY_DELAY_MS = 750;

const MOVE_POINTER_HINT = "Move the pointer, then click again.";

// A line saying to move the pointer, shown or hidden. Hidden, it keeps its room
// where a mouse may be, and takes none where only touch is. Assistive technology
// hears the hint from the page's move-pointer status region instead.
function movePointerLineClass(shown: boolean): string {
  return shown ? "" : " invisible hidden any-pointer-fine:block";
}

type PressButton = "connect" | "copy";

// Connect and Copy take a press only once the page has been visible and focused
// for a moment, and a mouse press only once the pointer has moved since then.
// Another page can bring this one forward under the person's cursor between the
// two clicks of a double-click, by closing a window it laid over this one, so
// the second click would land on a button the person never saw. Losing focus or
// visibility starts the wait again. Keyboard, touch and screen reader presses
// need only the wait.
//
// A press is judged when it starts, not when it ends: one that starts during the
// wait is refused however long it is held, and it starts the wait again, so a
// burst of clicks or Enter presses that runs on past the wait gets nothing
// either. A pointer that leaves the button and comes back during a press starts
// it again, which can refuse a press that started in time but never takes one
// that started too early.
//
// Once the wait is over the buttons look ready, so a mouse click one of them
// refuses, such as one from a pointer that has rested on it since the wait began
// again, shows a line under that button saying to move the pointer and click
// again. Where a mouse may be, the line keeps its room while hidden, so showing
// it moves nothing: the page is centered, and a line that took up new room would
// move the buttons from under the pointer.
function useReadyForPress(shown: boolean) {
  const [ready, setReady] = useState(false);
  // The button that refused the last mouse click while it looked ready.
  const [askToMovePointer, setAskToMovePointer] = useState<PressButton | null>(null);
  const readyRef = useRef(false);
  const pointerMovedRef = useRef(false);
  // How the press under way on each button was judged when it started. A press
  // that ends off its button leaves its verdict to that button's next press,
  // which it can only refuse.
  const pressesRef = useRef(new WeakMap<Element, "taken" | "refused">());
  const waitAgainRef = useRef(() => {});

  useEffect(() => {
    if (!shown) {
      return undefined;
    }
    let timer: number | undefined;
    const stop = () => {
      window.clearTimeout(timer);
      timer = undefined;
      readyRef.current = false;
      pointerMovedRef.current = false;
      setReady(false);
      setAskToMovePointer(null);
    };
    const start = () => {
      stop();
      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        readyRef.current = true;
        setReady(true);
      }, PRESS_READY_DELAY_MS);
    };
    const notePointerMove = () => {
      pointerMovedRef.current = true;
    };

    waitAgainRef.current = start;
    start();
    window.addEventListener("focus", start);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", start);
    window.addEventListener("pointermove", notePointerMove, true);
    return () => {
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", start);
      window.removeEventListener("pointermove", notePointerMove, true);
      waitAgainRef.current = () => {};
      stop();
    };
  }, [shown]);

  const notePressStart = (event: PressEvent) => {
    const presses = pressesRef.current;
    if (!readyRef.current) {
      waitAgainRef.current();
      presses.set(event.target, "refused");
    } else if (presses.get(event.target) !== "refused") {
      presses.set(event.target, event.pointerType !== "mouse" || pointerMovedRef.current ? "taken" : "refused");
    }
  };

  const takesPress = (event: PressEvent, button: PressButton) => {
    const startedAs = pressesRef.current.get(event.target);
    pressesRef.current.delete(event.target);
    const taken = startedAs === "taken" && readyRef.current && (event.pointerType !== "mouse" || pointerMovedRef.current);
    setAskToMovePointer(!taken && readyRef.current && event.pointerType === "mouse" ? button : null);
    return taken;
  };

  return { ready: shown && ready, askToMovePointer: shown ? askToMovePointer : null, notePressStart, takesPress };
}

// Any page can open this address with a callback and a state of its own, in a
// browser tab as readily as in a frame, so where the page was opened protects
// nothing. What protects every tab is the press: the page sends only when the
// person presses Connect after checking the code against their terminal. The
// desktop and mobile apps reach the page only through a link
// (instafy:///cli/login), and in a frame another page controls what the person
// sees and presses, so there the page offers no Connect at all: it sends
// nothing and shows no token.
function isOutsideABrowserPage(): boolean {
  if (isDesktopShell() || Capacitor.isNativePlatform()) {
    return true;
  }
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function CliLoginPage() {
  const auth = useAuth();
  const session = auth.session;
  const location = useLocation();
  const navigate = useNavigate();
  const outsideABrowserPage = isOutsideABrowserPage();
  // A session with no account behind it (a Supabase anonymous sign-in). Its
  // tokens never leave this page, by callback or by copy: the CLI needs an
  // account, and a second holder of the refresh token can end the session for
  // good. A user without the flag has an account. It is read on every render:
  // an account that arrives while the page is open, or before it opens again,
  // gets the page with its Connect button, which still sends nothing by itself.
  const anonymous = session?.user?.is_anonymous === true || auth.user?.is_anonymous === true;
  const withheld = anonymous || outsideABrowserPage;
  const token = withheld ? "" : session?.access_token ?? "";
  const refreshToken = withheld ? "" : session?.refresh_token ?? "";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [callbackState, setCallbackState] = useState<
    "idle" | "sending" | "sent" | "failed"
  >("idle");
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const callbackTimeoutMs = 4000;
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const { ready: readyForPress, askToMovePointer, notePressStart, takesPress } = useReadyForPress(Boolean(token));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Connect leaves the page once the CLI has the sign-in. Focus would fall to
  // the document, so it moves to the status that says what happened.
  useEffect(() => {
    if (callbackState === "sent" && (!document.activeElement || document.activeElement === document.body)) {
      statusRef.current?.focus();
    }
  }, [callbackState]);

  const serverUrl = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      return serverOrigin(params.get("serverUrl"));
    } catch (_error) {
      return null;
    }
  }, [location.search]);

  const cliCallbackUrl = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      return normalizeCliCallbackUrl(params.get("cliCallbackUrl"));
    } catch (_error) {
      return null;
    }
  }, [location.search]);

  const cliState = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      const raw = params.get("cliState");
      return raw && CLI_STATE_PATTERN.test(raw) ? raw : null;
    } catch (_error) {
      return null;
    }
  }, [location.search]);

  const cliPrintsCode = useMemo(() => {
    try {
      return new URLSearchParams(location.search).get("cliCode") === CLI_CODE_MARKER;
    } catch (_error) {
      return false;
    }
  }, [location.search]);

  const cliRequest = Boolean(cliCallbackUrl && cliState);
  const isCliCallbackFlow = cliRequest && cliPrintsCode;
  const olderCli = cliRequest && !cliPrintsCode;

  const displayToken = useMemo(() => {
    if (!token) {
      return "";
    }
    return copyState === "error" ? token : maskToken(token);
  }, [token, copyState]);

  const handleCopy = async (event: PressEvent) => {
    if (!token || !takesPress(event, "copy")) {
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy";

  // The sign-in goes to the CLI only from this press, never from a render or
  // an effect: an address alone, which any page can open, sends nothing.
  const handleConnect = async (event: PressEvent) => {
    if (
      withheld ||
      !token ||
      !isCliCallbackFlow ||
      !cliCallbackUrl ||
      !cliState ||
      sendingRef.current ||
      !takesPress(event, "connect")
    ) {
      return;
    }

    sendingRef.current = true;
    setCallbackState("sending");
    setCallbackError(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), callbackTimeoutMs);
    try {
      const params = new URLSearchParams({ token, state: cliState });
      if (refreshToken) {
        params.set("refreshToken", refreshToken);
      }
      if (supabaseUrl) {
        params.set("supabaseUrl", supabaseUrl);
      }
      if (supabaseAnonKey) {
        params.set("supabaseAnonKey", supabaseAnonKey);
      }

      // Whatever the CLI's address answers is final: a refusal does not send
      // the sign-in anywhere else, and a redirect fails instead of taking the
      // sign-in to the address it names. The CLI never redirects.
      const response = await fetch(cliCallbackUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        if (!mountedRef.current) {
          return;
        }
        setCallbackError(responseText || "Could not connect to the CLI callback. Copy the token into your terminal instead.");
        setCallbackState("failed");
        return;
      }
      if (!mountedRef.current) {
        return;
      }
      setCallbackState("sent");
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const message = (() => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return "Timed out connecting to the CLI callback. Copy the token into your terminal instead.";
        }
        const raw = error instanceof Error ? error.message : String(error);
        if (!raw) {
          return "Could not connect to the CLI callback. Copy the token into your terminal instead.";
        }
        return `Could not connect to the CLI callback. This is often caused by ad blockers/privacy tools blocking localhost requests. Copy the token into your terminal instead. (${raw})`;
      })();
      setCallbackError(message);
      setCallbackState("failed");
    } finally {
      window.clearTimeout(timeout);
      sendingRef.current = false;
    }
  };

  const callbackStatus =
    isCliCallbackFlow && callbackState === "sending"
      ? "Connecting to the CLI…"
      : isCliCallbackFlow && callbackState === "sent"
        ? "Connected. Your terminal continues on its own, and you can close this page."
        : isCliCallbackFlow && callbackState === "failed"
          ? "Could not connect to the CLI. Copy the token instead."
          : null;

  if (outsideABrowserPage) {
    return (
      <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-slate-950 dark:text-slate-100">
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-20">
          <div
            className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal md:p-8"
            data-testid="cli-login-browser-required"
          >
            <Heading level={1} variant="section" className="tracking-tight">
              Sign in to the CLI from a browser
            </Heading>
            <Text variant="lead" tone="secondary" className="mt-4">
              Open the link <code className="font-semibold">instafy login</code> prints in your web
              browser.
            </Text>
            <div className="mt-6 flex">
              <Button
                variant="primary"
                radius="full"
                onPress={() => navigate("/studio", { replace: true })}
                data-testid="cli-login-back-to-studio"
              >
                Back to Studio
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (anonymous) {
    return (
      <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-slate-950 dark:text-slate-100">
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-20">
          <div
            className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal md:p-8"
            data-testid="cli-login-account-required"
          >
            <Heading level={1} variant="section" className="tracking-tight">
              The Instafy CLI needs an account
            </Heading>
            <Text variant="lead" tone="secondary" className="mt-4">
              Create one, then run <code className="font-semibold">instafy login</code>.
            </Text>
            <div className="mt-6 flex">
              <Button
                variant="primary"
                radius="full"
                onPress={() => navigate("/studio", { replace: true })}
                data-testid="cli-login-create-account"
              >
                Create an account
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-slate-950 dark:text-slate-100">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-20">
        <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal md:p-8">
          <Heading level={1} variant="section" className="tracking-tight">
            Signed in to Instafy
          </Heading>

          {!isCliCallbackFlow ? (
            <Text variant="lead" tone="secondary" className="mt-4">
              Copy the token into your terminal.
            </Text>
          ) : null}

          {olderCli && token ? (
            <Text variant="caption" tone="muted" className="mt-2" data-testid="cli-login-update-cli">
              This CLI shows no confirmation code. To connect without copying, update it with{" "}
              <code className="font-semibold">npm i -g @instafy/cli</code> and run{" "}
              <code className="font-semibold">instafy login</code> again.
            </Text>
          ) : null}

          {/* Always present, so a screen reader hears what a press on Connect did. */}
          <div
            ref={statusRef}
            role="status"
            tabIndex={-1}
            className="outline-none"
            data-testid="cli-login-status-region"
          >
            {callbackStatus ? (
              <Text variant="lead" tone="secondary" className="mt-4" data-testid="cli-login-status">
                {callbackStatus}
              </Text>
            ) : null}

            {callbackError ? (
              <Text variant="caption" tone="muted" className="mt-2">
                {callbackError}
              </Text>
            ) : null}
          </div>

          {/* Always present, so a screen reader hears why a click on Connect or Copy did
              nothing. Each button's refusal adds a line of its own, so the hint is heard
              again when it moves to the other button with the same words. */}
          <div role="status" className="sr-only" data-testid="cli-login-move-pointer-status">
            {askToMovePointer ? <span key={askToMovePointer}>{MOVE_POINTER_HINT}</span> : null}
          </div>

          {serverUrl ? (
            <Text variant="caption" tone="muted" className="mt-2">
              Server: <span className="font-semibold">{serverUrl}</span>
            </Text>
          ) : null}

          {isCliCallbackFlow && cliState && token ? (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
              <Text variant="caption" tone="muted">
                Confirmation code
              </Text>
              <code
                className="mt-1 block font-mono text-2xl font-semibold tracking-widest text-slate-900 dark:text-slate-100"
                data-testid="cli-login-confirmation-code"
              >
                {confirmationCode(cliState)}
              </code>
              {callbackState !== "sent" ? (
                <>
                  <Text variant="body" tone="secondary" className="mt-3">
                    Press Connect only if you just ran{" "}
                    <code className="font-semibold">instafy login</code> and your terminal shows
                    this code.
                  </Text>
                  <div className="mt-4 flex flex-col items-start gap-2">
                    <Button
                      variant="primary"
                      radius="full"
                      isPending={callbackState === "sending"}
                      aria-disabled={readyForPress ? undefined : true}
                      className={readyForPress ? undefined : "opacity-60"}
                      onPressStart={notePressStart}
                      onPress={handleConnect}
                      data-testid="cli-login-connect"
                    >
                      Connect the CLI
                    </Button>
                    <Text
                      variant="caption"
                      tone="muted"
                      className={`text-balance${movePointerLineClass(askToMovePointer === "connect")}`}
                      aria-hidden="true"
                      data-testid="cli-login-move-pointer-connect"
                    >
                      {MOVE_POINTER_HINT}
                    </Text>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {!token ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              No active session token found. Try signing out and back in.
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-950 p-4 shadow-inner shadow-slate-900/20 dark:border-slate-800">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Text variant="caption" tone="inverse" className="text-slate-200">
                    Token
                  </Text>
                  <code
                    className="mt-2 block break-all text-xs font-semibold text-slate-100"
                    data-testid="cli-login-token"
                  >
                    {displayToken}
                  </code>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <IconButton
                    onPressStart={notePressStart}
                    onPress={handleCopy}
                    variant="primary"
                    size="xs"
                    radius="full"
                    aria-label="Copy token"
                    aria-disabled={readyForPress ? undefined : true}
                    className={readyForPress ? undefined : "opacity-60"}
                    title={copyLabel}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>

              {copyState !== "idle" ? (
                <Text variant="caption" tone="inverse" className="mt-3 text-slate-200">
                  {copyLabel}
                </Text>
              ) : null}

              <Text
                variant="caption"
                tone="inverse"
                className={`mt-2 text-balance text-right text-slate-200${movePointerLineClass(askToMovePointer === "copy")}`}
                aria-hidden="true"
                data-testid="cli-login-move-pointer-copy"
              >
                {MOVE_POINTER_HINT}
              </Text>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
