import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../../components/Button";
import { LoadingStatus } from "../../../../components/LoadingStatus";
import { Surface } from "../../../../components/Surface";
import { Text } from "../../../../components/Text";
import { openExternalUrl } from "../../../../utils/openExternalUrl";
import type { DeviceAuthSession } from "./useDeviceAuthFlow";

type CopyTarget = "link" | "code";
type CopyOutcome = { target: CopyTarget; result: "copied" | "selected" };

const FALLBACK_LOGIN_HOST = "auth.openai.com";

type LoginPage = {
  host: string;
  // The page as people read and type it (no scheme), and the exact link to
  // copy. Both are null unless the session's link is https.
  display: string | null;
  href: string | null;
};

function describeLoginPage(verificationUrl: string): LoginPage {
  try {
    const url = new URL(verificationUrl);
    if (url.protocol !== "https:") {
      return { host: url.hostname || FALLBACK_LOGIN_HOST, display: null, href: null };
    }
    const path = url.pathname === "/" ? "" : url.pathname;
    return { host: url.hostname, display: `${url.host}${path}${url.search}`, href: url.href };
  } catch (_error) {
    return { host: FALLBACK_LOGIN_HOST, display: null, href: null };
  }
}

function formatTimeLeft(expiresAt: string, nowMs: number): string | null {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Embedded browsers refuse clipboard writes. Selecting the value instead lets
// a keyboard copy or a long press take it.
function selectContents(element: HTMLElement | null) {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!element || !selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

export type ChatGptDeviceLoginCardProps = {
  session: DeviceAuthSession;
  busy: boolean;
  completing: boolean;
  onCancel: () => void;
  onTryAgain: () => void;
};

/**
 * ChatGPT device login as the two things people do: open OpenAI's page (in
 * any browser), then enter the code there. Render it with `key` set to the
 * session id so a new code starts with fresh copy state.
 */
export function ChatGptDeviceLoginCard({
  session,
  busy,
  completing,
  onCancel,
  onTryAgain,
}: ChatGptDeviceLoginCardProps) {
  const pending = session.status === "pending";
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome | null>(null);
  const linkRef = useRef<HTMLSpanElement>(null);
  const codeRef = useRef<HTMLSpanElement>(null);
  const page = useMemo(() => describeLoginPage(session.verificationUrl), [session.verificationUrl]);
  const timeLeft = useMemo(() => formatTimeLeft(session.expiresAt, nowMs), [session.expiresAt, nowMs]);

  useEffect(() => {
    if (!pending) {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [pending]);

  const copy = async (target: CopyTarget, value: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopyOutcome({ target, result: "copied" });
    } catch (_error) {
      selectContents(target === "link" ? linkRef.current : codeRef.current);
      setCopyOutcome({ target, result: "selected" });
    }
  };

  const copyLabel = (target: CopyTarget) => {
    if (copyOutcome?.target !== target) {
      return "Copy";
    }
    return copyOutcome.result === "copied" ? "Copied" : "Selected";
  };

  if (session.status === "failed") {
    return (
      <Surface tone="muted" radius="xl" shadow="none" className="p-3" data-testid="credentials-codex-device-login">
        <Text variant="caption" tone="danger" role="alert">
          {session.error ?? "Device login failed."}
        </Text>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onPress={onTryAgain} variant="primary" size="xs" radius="full" isDisabled={busy}>
            Try again
          </Button>
          <Button onPress={onCancel} variant="ghost" size="xs" radius="full" isDisabled={busy}>
            Back
          </Button>
        </div>
      </Surface>
    );
  }

  return (
    <Surface tone="muted" radius="xl" shadow="none" className="p-3" data-testid="credentials-codex-device-login">
      <Text variant="caption" tone="muted">
        Approve Instafy on OpenAI&apos;s site. This finishes by itself.
      </Text>
      <ol
        role="list"
        className="mt-3 list-none divide-y divide-slate-200/70 border-y border-slate-200/70 dark:divide-slate-800 dark:border-slate-800"
      >
        <li className="py-2.5" data-testid="credentials-codex-device-login-link">
          <Text variant="caption" tone="muted">
            <span aria-hidden="true">1&nbsp;&nbsp;</span>Open this page, in any browser
          </Text>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              ref={linkRef}
              data-testid="credentials-codex-device-login-url"
              className="min-w-0 flex-1 select-all break-words text-sm text-slate-800 dark:text-slate-100"
            >
              {page.display ?? page.host}
            </span>
            <Button
              onPress={() => void openExternalUrl(session.verificationUrl)}
              variant="primary"
              size="sm"
              radius="full"
              isDisabled={busy}
              aria-label={`Open ${page.host}`}
            >
              Open ↗
            </Button>
            {page.href ? (
              <Button
                onPress={() => void copy("link", page.href ?? session.verificationUrl)}
                variant="outline"
                size="sm"
                radius="full"
                isDisabled={busy}
                aria-label="Copy login link"
              >
                {copyLabel("link")}
              </Button>
            ) : null}
          </div>
        </li>
        <li className="py-2.5">
          <Text variant="caption" tone="muted">
            <span aria-hidden="true">2&nbsp;&nbsp;</span>Enter this code there
          </Text>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              ref={codeRef}
              data-testid="credentials-codex-device-code"
              className="min-w-0 flex-1 select-all break-all font-mono text-lg font-semibold tracking-widest text-slate-800 dark:text-slate-100"
            >
              {session.userCode}
            </span>
            <Button
              onPress={() => void copy("code", session.userCode)}
              variant="outline"
              size="sm"
              radius="full"
              isDisabled={busy}
              aria-label="Copy device code"
            >
              {copyLabel("code")}
            </Button>
          </div>
        </li>
      </ol>
      <span className="sr-only" aria-live="polite">
        {copyOutcome?.result === "selected"
          ? "Copying is blocked here, so the text is selected. Copy it with your keyboard or a long press."
          : ""}
      </span>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {pending ? (
          <LoadingStatus size="xs">
            {completing ? "Approved. Checking the connection…" : "Waiting for approval…"}
          </LoadingStatus>
        ) : null}
        {pending && !completing && timeLeft ? (
          <Text as="span" variant="caption" tone="muted">
            {timeLeft} left
          </Text>
        ) : null}
        <Button onPress={onCancel} variant="ghost" size="sm" radius="full" isDisabled={busy} className="ml-auto">
          Cancel
        </Button>
      </div>
      <Text variant="caption" tone="muted" className="mt-2">
        Use this code only on{" "}
        <Text as="span" variant="captionStrong" tone="inherit">
          {page.host}
        </Text>
        . OpenAI may email you its own sign-in code first.
      </Text>
    </Surface>
  );
}
