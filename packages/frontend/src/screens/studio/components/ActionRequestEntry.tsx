import { useCallback, useContext, useMemo, useRef, useState } from "react";
import { Key, MapPin, NavArrowDown, Terminal, WebWindow } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioListBox, StudioListBoxItem } from "../../../components/aria/StudioListBox";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { Badge } from "../../../components/Badge";
import { Spinner } from "../../../components/Spinner";
import { useStatus } from "../../../status/useStatus";
import {
  BrowserRequestHostContext,
  browserRequestDestinations,
  browserRequestFromMessage,
  browserRequestKey,
  browserRequestUnavailableReason,
} from "./browserRequest";
import { ChatActionCard, type ChatActionCardAction } from "./ChatActionCard";
import { TurnActivityLine } from "./TurnActivityLine";
import type { ChatMessage } from "../types";

type ParsedActionRequest = {
  testId: string | null;
  icon: "terminal" | "key" | "location" | "preview" | null;
  overline: string | null;
  title: string | null;
  description: string | null;
  context: string | null;
  input: ParsedActionRequestInput | null;
  actions: ParsedActionRequestAction[];
};

type ParsedActionRequestInput = {
  placeholder: string | null;
  testId: string | null;
  options: ParsedActionRequestOption[] | null;
};

type ParsedActionRequestOption = {
  value: string;
  label: string;
};

type ParsedActionRequestAction = {
  id: string;
  label: string;
  variant: "primary" | "outline" | "ghost";
  href: string | null;
  eventName: string | null;
  args: unknown[];
  usesInput: boolean;
  timeoutMs: number;
  busyLabel: string | null;
  successToast: string | null;
  testId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function readBoolean(record: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }
  return false;
}

function parseInputOptions(options: unknown): ParsedActionRequestOption[] | null {
  if (!Array.isArray(options)) {
    return null;
  }
  const parsed: ParsedActionRequestOption[] = [];
  for (const entry of options) {
    if (!entry || !isRecord(entry)) {
      continue;
    }
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : value;
    if (!value) {
      continue;
    }
    parsed.push({ value, label: label || value });
    if (parsed.length >= 200) {
      break;
    }
  }
  return parsed;
}

function parseActionRequestDetails(details: Record<string, unknown> | null | undefined): ParsedActionRequest | null {
  if (!details || !isRecord(details)) {
    return null;
  }

  const testId = readString(details, ["testId", "test_id", "cardTestId", "card_test_id"]);
  const icon = readString(details, ["icon", "iconName", "icon_name"]);
  const parsedIcon = icon ? (icon.trim().toLowerCase() as ParsedActionRequest["icon"]) : null;

  const overline = readString(details, ["overline", "label", "eyebrow"]);
  const title = readString(details, ["title", "heading"]);
  const description = readString(details, ["description", "detail", "body"]);
  const context = readString(details, ["context", "contextText", "context_text"]);
  const inputType = readString(details, ["inputType", "input_type"])?.toLowerCase() ?? "";
  const inputPlaceholder = readString(details, ["inputPlaceholder", "input_placeholder", "inputHint", "input_hint"]);
  const inputTestId = readString(details, ["inputTestId", "input_test_id"]);
  const rawInputOptions =
    details["inputOptions"] ?? details["input_options"] ?? details["options"] ?? details["selectOptions"] ?? null
  const parsedOptions = parseInputOptions(rawInputOptions);
  const shouldUseSelect = inputType === "select" || inputType === "dropdown" || parsedOptions !== null;
  const inputOptions = shouldUseSelect ? (parsedOptions ?? []) : null;
  const input =
    inputPlaceholder || inputTestId || inputOptions !== null
      ? { placeholder: inputPlaceholder, testId: inputTestId, options: inputOptions }
      : null;

  const rawActions = Array.isArray(details["actions"]) ? details["actions"] : null;
  const actions: ParsedActionRequestAction[] = [];
  if (rawActions) {
    for (const entry of rawActions) {
      if (!entry || !isRecord(entry)) {
        continue;
      }
      const label = readString(entry, ["label", "title", "text"]);
      if (!label) {
        continue;
      }
      const id = readString(entry, ["id", "key"]) ?? label.toLowerCase().replace(/\s+/g, "-");
      const rawVariant = readString(entry, ["variant"])?.toLowerCase() ?? "";
      const variant: ParsedActionRequestAction["variant"] =
        rawVariant === "primary" || rawVariant === "outline" || rawVariant === "ghost"
          ? rawVariant
          : "outline";
      const href = readString(entry, ["href", "url"]);
      const eventName = readString(entry, ["event", "eventName", "event_name"]);
      const args = Array.isArray(entry["args"]) ? entry["args"] : [];
      const usesInput = readBoolean(entry, ["usesInput", "uses_input", "withInput", "with_input"]);
      const timeoutMs = Math.max(250, readNumber(entry, ["timeoutMs", "timeout_ms"]) ?? 15_000);
      const busyLabel = readString(entry, ["busyLabel", "busy_label", "loadingLabel", "loading_label"]);
      const successToast = readString(entry, ["successToast", "success_toast"]);
      const actionTestId = readString(entry, ["testId", "test_id"]);

      actions.push({
        id,
        label,
        variant,
        href,
        eventName,
        args,
        usesInput,
        timeoutMs,
        busyLabel,
        successToast,
        testId: actionTestId,
      });
    }
  }

  if (!title && actions.length === 0) {
    return null;
  }

  return {
    testId,
    icon:
      parsedIcon === "terminal" || parsedIcon === "key" || parsedIcon === "location" || parsedIcon === "preview"
        ? parsedIcon
        : null,
    overline,
    title,
    description,
    context,
    input,
    actions,
  };
}

function resolveIcon(icon: ParsedActionRequest["icon"]) {
  switch (icon) {
    case "terminal":
      return <Terminal className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
    case "key":
      return <Key className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
    case "location":
      return <MapPin className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
    case "preview":
      return <WebWindow className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
    default:
      return null;
  }
}

export function ActionRequestEntry({
  message,
  details,
}: {
  message: ChatMessage;
  details: Record<string, unknown> | null;
}) {
  const { showStatus } = useStatus();
  const parsed = useMemo(() => parseActionRequestDetails(details), [details]);
  // A request_browser card names where its task is headed, so the press is
  // consent to a destination the person can see, and it cannot be pressed
  // where no browser can open. The host comes from the task's text, not from
  // the page the browser reached, so the card never says the site opened.
  const browserHost = useContext(BrowserRequestHostContext);
  const browserRequest = useMemo(() => browserRequestFromMessage(message), [message]);
  const browserDestinations = useMemo(
    () => (browserRequest ? browserRequestDestinations(browserRequest.task) : []),
    [browserRequest],
  );
  const browserUnavailable =
    browserRequest && browserHost ? browserRequestUnavailableReason(browserRequest, browserHost) : null;
  // Studio opens the browser for a card by itself where it can: the card then
  // reads Opening and then Opened in place of its button. Where it cannot,
  // the button stays, with the reason when there is one. A continued card
  // reads Opened after a reload too, so an old card is not pressed again. A
  // card a newer card followed offers no button either: the newer one
  // carries the task on, so two live cards never stack up.
  const browserKey = browserRequest ? browserRequestKey(message) : null;
  const browserCardState = browserKey ? browserHost?.cardStates?.get(browserKey) ?? null : null;
  const browserSuperseded = Boolean(browserKey && browserHost?.newestCardKey && browserHost.newestCardKey !== browserKey);
  const browserPhase = browserKey && (browserHost?.continuedKeys?.has(browserKey) || browserCardState?.kind === "opened")
    ? "opened"
    : browserCardState?.kind === "opening"
      ? "opening"
      : browserSuperseded ? "superseded" : "button";
  const browserReason = browserPhase === "button" && browserCardState?.kind === "button" && !browserUnavailable
    ? browserCardState.reason
    : null;
  const browserUnavailableNote = browserPhase === "button" ? browserUnavailable : null;
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [selectOpen, setSelectOpen] = useState(false);
  const selectTriggerRef = useRef<HTMLButtonElement | null>(null);

  const handlePress = useCallback(
    async (action: ParsedActionRequestAction) => {
      if (busyActionId) {
        return;
      }
      const trimmedInput = inputValue.trim();
      if (action.usesInput && !trimmedInput) {
        showStatus("Provide the required input first.", "error", 4000);
        return;
      }
      setBusyActionId(action.id);
      try {
        if (action.href) {
          try {
            window.open(action.href, "_blank", "noopener,noreferrer");
          } catch {
            showStatus("Unable to open the link.", "error", 5000);
          }
          return;
        }

        if (action.eventName) {
          const trimmed = action.eventName.trim();
          if (!trimmed.startsWith("instafy:")) {
            showStatus("Unsupported action configured.", "error", 5000);
            return;
          }
          if (typeof window === "undefined") {
            showStatus("This action is only available in the browser.", "error", 5000);
            return;
          }
          const args = action.usesInput ? [...action.args, trimmedInput] : action.args;
          const detail: {
            messageId: string;
            args: unknown[];
            input: string | null;
            completion?: Promise<unknown> | null;
          } = {
            messageId: message.id,
            args,
            input: action.usesInput ? trimmedInput : null,
            completion: null,
          };
          window.dispatchEvent(
            new CustomEvent(trimmed, {
              detail,
            }),
          );
          if (detail.completion) {
            try {
              await detail.completion;
            } catch {
              return;
            }
          }
          if (action.successToast) {
            showStatus(action.successToast, "info", 3000);
          }
          return;
        }

        showStatus("No action configured.", "error", 4000);
      } finally {
        setBusyActionId(null);
      }
    },
    [busyActionId, inputValue, message.id, showStatus]
  );

  // A message Octo sent straight to the browser: while Studio opens its card
  // by itself, and until that browser turn shows something, the turn's one
  // line says so; then the browser turn's own line follows
  // (routedBrowserFold.ts). A card that stays a button, one the person
  // pressed, or one whose browser turn failed before it ran shows as any card
  // does: nothing is opening it.
  const routedOpening = Boolean(browserRequest?.routed && browserKey && (
    browserCardState?.kind === "opening" || browserHost?.routedWaitingKeys?.has(browserKey)
  ));
  if (routedOpening) {
    return (
      <div className="space-y-1" data-testid="routed-browser-opening">
        <TurnActivityLine
          text="Opening Instafy's browser…"
          live
          animate
          interactive={false}
          detailsOpen={false}
          detailsId=""
          onToggleDetails={() => {}}
        />
        {browserPhase === "opening" && browserCardState?.kind === "opening" && browserCardState.note ? (
          <Text as="div" variant="caption" tone="muted" data-testid="browser-request-opening-note">
            {browserCardState.note}
          </Text>
        ) : null}
      </div>
    );
  }

  if (!parsed) {
    if (message.content.trim().length === 0) {
      return null;
    }
    return (
      <ChatActionCard
        title={message.content.trim()}
        actions={[
          {
            id: "open-external",
            label: "Open",
            variant: "outline",
            onPress: () => {},
            isDisabled: true,
          },
        ]}
      />
    );
  }

  const visibleActions = browserPhase === "button"
    ? parsed.actions
    : parsed.actions.filter((action) => action.eventName !== "instafy:request-browser");
  const actions: ChatActionCardAction[] = visibleActions.map((action) => ({
    id: action.id,
    label: action.label,
    variant: action.variant,
    onPress: () => void handlePress(action),
    isDisabled:
      busyActionId !== null ||
      (action.usesInput && inputValue.trim().length === 0) ||
      (browserUnavailable !== null && action.eventName === "instafy:request-browser"),
    isLoading: busyActionId === action.id,
    loadingLabel: action.busyLabel,
    testId: action.testId ?? undefined,
  }));

  const fallbackTitle = parsed.title ?? message.content.trim() ?? "Action required";
  const icon = resolveIcon(parsed.icon);

  return (
    <ChatActionCard
      testId={parsed.testId ?? undefined}
      icon={icon}
      overline={parsed.overline}
      title={fallbackTitle}
      // A browser card says what it is for, never what pressing it does:
      // Studio opens it by itself where it can, and it reads Opening and
      // Opened. Older cards carry a line about that; it is not shown.
      description={browserRequest ? null : parsed.description}
      children={
        parsed.input || parsed.context || (browserPhase === "button" && browserDestinations.length > 0) ||
          browserUnavailableNote || browserPhase !== "button" || browserReason ? (
          <div className="space-y-2">
            {browserPhase === "opening" ? (
              <Text as="div" variant="caption" tone="muted" className="flex items-center gap-2 break-all" data-testid="browser-request-opening">
                <Spinner aria-hidden="true" tone="slate" size="sm" />
                <span>
                  Opening Instafy&apos;s browser{browserDestinations.length > 0 ? (
                    <> for <span className="font-mono text-slate-700 dark:text-slate-200">{browserDestinations[0]}</span></>
                  ) : null}
                </span>
              </Text>
            ) : browserPhase === "opened" ? (
              <div className="flex items-center gap-2" data-testid="browser-request-opened">
                <Badge tone="success">Opened</Badge>
              </div>
            ) : browserPhase === "superseded" ? (
              <div className="flex items-center gap-2" data-testid="browser-request-not-opened">
                <Badge tone="neutral">Not opened</Badge>
              </div>
            ) : browserPhase === "button" && browserDestinations.length > 0 ? (
              <Text as="div" variant="caption" tone="muted" className="break-all" data-testid="browser-request-destination">
                For <span className="font-mono text-slate-700 dark:text-slate-200">{browserDestinations.join(", ")}</span>
              </Text>
            ) : null}
            {browserPhase === "opening" && browserCardState?.kind === "opening" && browserCardState.note ? (
              <Text as="div" variant="caption" tone="muted" data-testid="browser-request-opening-note">
                {browserCardState.note}
              </Text>
            ) : null}
            {browserReason ? (
              <Text as="div" variant="caption" tone="muted" data-testid="browser-request-reason">
                {browserReason}
              </Text>
            ) : null}
            {browserUnavailableNote ? (
              <Text as="div" variant="caption" tone="muted" data-testid="browser-request-unavailable">
                {browserUnavailableNote}
              </Text>
            ) : null}
            {parsed.context ? (
              <Text as="div" variant="mono" tone="muted" className="break-all">
                {parsed.context}
              </Text>
              ) : null}
              {parsed.input ? (
                parsed.input.options ? (
                  <>
                    <Button
                      ref={selectTriggerRef}
                      variant="outline"
                      size="sm"
                      radius="xl"
                      fullWidth
                      isDisabled={busyActionId !== null || parsed.input.options.length === 0}
                      aria-label={parsed.input.placeholder ?? "Select an option"}
                      aria-haspopup="listbox"
                      aria-expanded={selectOpen}
                      data-testid={parsed.input.testId ?? undefined}
                      onPress={() => setSelectOpen((open) => !open)}
                      className="justify-between bg-white shadow-none hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-900 dark:data-[hovered]:bg-slate-900"
                    >
                      {(() => {
                        const selected =
                          inputValue.trim().length > 0
                            ? parsed.input.options.find((option) => option.value === inputValue.trim()) ?? null
                            : null;
                        const label = selected ? selected.label : parsed.input.placeholder ?? "Select an option";
                        const isPlaceholder = !selected;
                        return (
                          <>
                            <span
                              className={[
                                "min-w-0 flex-1 truncate text-left",
                                isPlaceholder ? "text-slate-400 dark:text-slate-500" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {label}
                            </span>
                            <NavArrowDown className="text-sm text-slate-400" aria-hidden="true" />
                          </>
                        );
                      })()}
                    </Button>
                    <StudioPopover
                      isNonModal
                      triggerRef={selectTriggerRef}
                      isOpen={selectOpen}
                      onOpenChange={setSelectOpen}
                      placement="bottom start"
                      offset={6}
                      className="min-w-[var(--trigger-width)] p-2"
                    >
                      <StudioListBox
                        aria-label={parsed.input.placeholder ?? "Select an option"}
                        selectionMode="single"
                        selectedKeys={inputValue.trim().length > 0 ? new Set([inputValue.trim()]) : new Set()}
                        className="space-y-1"
                      >
                        {parsed.input.options.map((option) => (
                          <StudioListBoxItem
                            key={option.value}
                            id={option.value}
                            textValue={option.label}
                            onAction={() => {
                              setInputValue(option.value);
                              setSelectOpen(false);
                            }}
                          >
                            <span
                              data-testid={
                                parsed.input?.testId ? `${parsed.input.testId}-option-${option.value}` : undefined
                              }
                            >
                              {option.label}
                            </span>
                          </StudioListBoxItem>
                        ))}
                      </StudioListBox>
                    </StudioPopover>
                  </>
                ) : (
                  <Input
                    value={inputValue}
                    onChange={(event) => setInputValue(event.currentTarget.value)}
                    placeholder={parsed.input.placeholder ?? undefined}
                  data-testid={parsed.input.testId ?? undefined}
                  size="sm"
                  radius="xl"
                />
              )
            ) : null}
          </div>
        ) : null
      }
      actions={actions}
    />
  );
}
