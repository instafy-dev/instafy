import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalTextEntity } from "@lexical/react/useLexicalTextEntity";
import type { EntityMatch } from "@lexical/text";
import { $createTextNode, $insertNodes, $isTextNode, type TextNode } from "lexical";
import type { AssistantMentionToken } from "../../../../conversations/assistantMentions";
import { Text } from "../../../../components/Text";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../../utils/agentAvatar";
import {
  getBuiltInAssistantMentionPatternSource,
  listBuiltInAssistantDefinitions,
  normalizeAgentHandle,
  normalizeCustomAgentHandle,
  resolveBuiltInAssistantHandle,
} from "../../../../assistants/localBuiltInAssistantCatalog";
import type { ControllerProjectMember } from "../../../../sdk/instafy";
import { resolveAssistantMentionToken } from "../assistantMentionUI";
import { $createAgentMentionNode, AgentMentionNode } from "./AgentMentionNode";
import { $createAssistantMentionNode, AssistantMentionNode } from "./AssistantMentionNode";
import { $createUserMentionNode } from "./UserMentionNode";

export type MentionAgentProfile = {
  handle?: string | null;
  displayName?: string | null;
  avatarSeed?: string | null;
  avatarUrl?: string | null;
};

type MentionOptionConfig =
  | {
      kind: "assistant";
      token: AssistantMentionToken;
      label: string;
      description: string;
    }
  | {
      kind: "agent";
      token: string;
      label: string;
      description: string;
    }
  | {
      kind: "user";
      userId: string;
      handle: string;
      displayName: string;
      token: string;
      label: string;
      description: string;
    };

class AssistantMentionOption extends MenuOption {
  kind: MentionOptionConfig["kind"];
  token: string;
  label: string;
  description: string;
  userId: string | null;
  handle: string | null;
  displayName: string | null;

  constructor(config: MentionOptionConfig) {
    const key =
      config.kind === "user"
        ? `user:${config.userId}`
        : `${config.kind}:${config.token}`;
    super(key);
    this.kind = config.kind;
    this.token = config.token;
    this.label = config.label;
    this.description = config.description;
    this.userId = config.kind === "user" ? config.userId : null;
    this.handle = config.kind === "user" ? config.handle : null;
    this.displayName = config.kind === "user" ? config.displayName : null;
  }
}

type AssistantMentionsMenuProps = {
  anchorElement: HTMLElement;
  options: AssistantMentionOption[];
  selectedIndex: number | null;
  selectOptionAndCleanUp: (option: AssistantMentionOption) => void;
  setHighlightedIndex: (index: number) => void;
  agentProfilesByHandle: Map<string, MentionAgentProfile>;
};

type AssistantMentionsPluginProps = {
  agentHandles?: string[];
  agentProfiles?: MentionAgentProfile[];
  mentionableUsers?: ControllerProjectMember[];
};

const ASSISTANT_MENTION_OPTIONS: MentionOptionConfig[] = [
  ...listBuiltInAssistantDefinitions().map(
    (definition): MentionOptionConfig => ({
      kind: "assistant",
      token: definition.mentionToken,
      label: definition.displayName,
      description: `Route this message to ${definition.displayName}.`,
    }),
  ),
];

const MENTION_MATCH_REGEX = new RegExp(
  `(^|\\s)((?:${getBuiltInAssistantMentionPatternSource()})\\b)`,
  "i",
);
const AGENT_MENTION_MATCH_REGEX = /(^|\s)(@[a-z0-9][a-z0-9_-]{0,19}\b)/i;

const USER_HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const MENTION_MENU_MAX_HEIGHT_PX = 320;
const MENTION_MENU_MIN_HEIGHT_PX = 140;
const MENTION_MENU_MAX_WIDTH_PX = 352;
const MENTION_MENU_VIEWPORT_PADDING_PX = 8;
const MENTION_MENU_ANCHOR_GAP_PX = 6;

type MentionMenuLayout = { placeAbove: boolean; maxHeight: number };

function formatAgentDisplayName(handle: string): string {
  const trimmed = (handle ?? "").trim();
  if (!trimmed) {
    return "Agent";
  }
  const words = trimmed
    .split(/[_-]+/g)
    .filter((word) => word.length > 0)
    .map((word) => {
      const [first, ...rest] = word;
      if (!first) {
        return word;
      }
      return `${first.toUpperCase()}${rest.join("")}`;
    });
  return words.length > 0 ? words.join(" ") : trimmed;
}

function normalizeAgentHandles(handles: string[] | undefined): string[] {
  if (!handles || handles.length === 0) {
    return [];
  }
  const unique = new Set<string>();
  for (const handle of handles) {
    const normalized = normalizeCustomAgentHandle(handle);
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return Array.from(unique);
}

function resolveUserDisplayName(member: ControllerProjectMember): string {
  const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
  if (fullName) {
    return fullName;
  }
  const email = typeof member.email === "string" ? member.email.trim() : "";
  if (email) {
    return email;
  }
  return "Teammate";
}

function resolveUserHandle(member: ControllerProjectMember): string {
  const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
  const firstName = fullName ? fullName.split(/\s+/)[0] ?? "" : "";
  const email = typeof member.email === "string" ? member.email.trim() : "";
  const emailPrefix = email ? email.split("@")[0] ?? "" : "";
  const seed = (firstName || emailPrefix || "teammate").trim();
  let handle = seed.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!handle) {
    handle = "teammate";
  }
  handle = handle.slice(0, 20);
  if (!USER_HANDLE_REGEX.test(handle)) {
    handle = `teammate-${member.userId.slice(0, 4).toLowerCase()}`;
  }
  return handle.slice(0, 20);
}

/**
 * A human handle must never equal a built-in assistant handle/alias or a
 * configured agent handle, or the text-only submit routing would dispatch AI
 * against explicit human intent (e.g. "Ai Chen" -> "@ai"). Suffix without a
 * separator: "@ai-2" still matches the assistant mention pattern's word
 * boundary, while "@ai2" cannot.
 */
function avoidAgentUserHandleCollision(
  baseHandle: string,
  isAgentHandle: (handle: string) => boolean,
): string {
  if (!isAgentHandle(baseHandle)) {
    return baseHandle;
  }
  for (let suffix = 2; ; suffix += 1) {
    const digits = String(suffix);
    const candidate = `${baseHandle.slice(0, 20 - digits.length)}${digits}`;
    if (!isAgentHandle(candidate)) {
      return candidate;
    }
  }
}

function normalizeMentionableUsers(
  users: ControllerProjectMember[] | undefined,
  isAgentHandle: (handle: string) => boolean,
): MentionOptionConfig[] {
  if (!users || users.length === 0) {
    return [];
  }
  const seenUserIds = new Set<string>();
  const seenHandles = new Map<string, number>();
  const options: MentionOptionConfig[] = [];

  for (const member of users) {
    const userId = typeof member.userId === "string" ? member.userId.trim() : "";
    if (!userId || seenUserIds.has(userId)) {
      continue;
    }
    seenUserIds.add(userId);

    const displayName = resolveUserDisplayName(member);
    const email = typeof member.email === "string" ? member.email.trim() : "";
    const baseHandle = avoidAgentUserHandleCollision(
      resolveUserHandle(member),
      isAgentHandle,
    );
    const count = seenHandles.get(baseHandle) ?? 0;
    seenHandles.set(baseHandle, count + 1);
    const handle = count === 0 ? baseHandle : `${baseHandle.slice(0, 18)}-${count + 1}`.slice(0, 20);
    const token = `@${handle}`;

    options.push({
      kind: "user",
      userId,
      handle,
      displayName,
      token,
      label: displayName,
      description: email || "Teammate",
    });
  }

  return options;
}

export function buildAssistantMentionOptionConfigs({
  agentHandles,
  agentProfiles,
  mentionableUsers,
}: {
  agentHandles?: string[];
  agentProfiles?: MentionAgentProfile[];
  mentionableUsers?: ControllerProjectMember[];
}): MentionOptionConfig[] {
  const normalizedAgentHandles = normalizeAgentHandles(agentHandles);
  const agentProfilesByHandle = new Map<string, MentionAgentProfile>();
  for (const profile of agentProfiles ?? []) {
    const normalized = normalizeAgentHandle(profile.handle);
    if (!normalized) {
      continue;
    }
    agentProfilesByHandle.set(normalized, profile);
  }
  const agentOptions: MentionOptionConfig[] = normalizedAgentHandles.map((handle) => ({
    kind: "agent",
    token: `@${handle}`,
    label: agentProfilesByHandle.get(handle)?.displayName?.trim() || formatAgentDisplayName(handle),
    description: `Route this message to ${
      agentProfilesByHandle.get(handle)?.displayName?.trim() || formatAgentDisplayName(handle)
    }.`
  }));
  const agentHandleSet = new Set(normalizedAgentHandles);
  const userOptions = normalizeMentionableUsers(
    mentionableUsers,
    (handle) => resolveBuiltInAssistantHandle(handle) !== null || agentHandleSet.has(handle),
  );
  return [...ASSISTANT_MENTION_OPTIONS, ...userOptions, ...agentOptions];
}

function resolveMentionMenuLayout(anchorElement: HTMLElement): MentionMenuLayout {
  const rect = anchorElement.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - MENTION_MENU_VIEWPORT_PADDING_PX - MENTION_MENU_ANCHOR_GAP_PX;
  const spaceAbove = rect.top - MENTION_MENU_VIEWPORT_PADDING_PX - MENTION_MENU_ANCHOR_GAP_PX;
  const placeAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
  const availableHeight = Math.max(
    MENTION_MENU_MIN_HEIGHT_PX,
    placeAbove ? spaceAbove : spaceBelow,
  );
  const maxHeight = Math.min(MENTION_MENU_MAX_HEIGHT_PX, availableHeight);
  return { placeAbove, maxHeight };
}

function AssistantMentionsMenu({
  anchorElement,
  options,
  selectedIndex,
  selectOptionAndCleanUp,
  setHighlightedIndex,
  agentProfilesByHandle,
}: AssistantMentionsMenuProps) {
  const optionSignature = useMemo(() => options.map((option) => option.key).join("|"), [options]);

  useEffect(() => {
    if (options.length === 0) {
      return;
    }
    setHighlightedIndex(0);
  }, [optionSignature, options.length, setHighlightedIndex]);

  const anchorRect = anchorElement.getBoundingClientRect();
  const inputRect =
    typeof document !== "undefined"
      ? document.getElementById("studio-chat-input")?.getBoundingClientRect()
      : null;
  const anchorTop = inputRect ? Math.min(anchorRect.top, inputRect.top) : anchorRect.top;
  const anchorBottom = inputRect ? Math.max(anchorRect.bottom, inputRect.bottom) : anchorRect.bottom;
  const menuLayout = resolveMentionMenuLayout(anchorElement);
  const maxWidth = Math.max(
    220,
    Math.min(MENTION_MENU_MAX_WIDTH_PX, window.innerWidth - MENTION_MENU_VIEWPORT_PADDING_PX * 2),
  );
  const clampedLeft = Math.max(
    MENTION_MENU_VIEWPORT_PADDING_PX,
    Math.min(anchorRect.left, window.innerWidth - maxWidth - MENTION_MENU_VIEWPORT_PADDING_PX),
  );
  const menuStyle: CSSProperties = {
    maxHeight: menuLayout.maxHeight,
    width: maxWidth,
    left: clampedLeft,
    top: menuLayout.placeAbove
      ? Math.max(MENTION_MENU_VIEWPORT_PADDING_PX, anchorTop - MENTION_MENU_ANCHOR_GAP_PX)
      : Math.min(window.innerHeight - MENTION_MENU_VIEWPORT_PADDING_PX, anchorBottom + MENTION_MENU_ANCHOR_GAP_PX),
    transform: menuLayout.placeAbove ? "translateY(-100%)" : undefined,
  };

  return createPortal(
    <div
      className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-800 dark:bg-slate-900"
      style={menuStyle}
      data-testid="assistant-mention-menu"
    >
      {options.map((option, index) => (
        <button
          key={option.key}
          ref={option.setRefElement}
          type="button"
          data-testid="assistant-mention-option"
          data-token={option.token}
          data-highlighted={selectedIndex === index ? "true" : "false"}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
            selectedIndex === index
              ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/70"
          }`}
          onClick={() => selectOptionAndCleanUp(option)}
          onMouseEnter={() => setHighlightedIndex(index)}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white text-3xs font-semibold text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {(() => {
              if (option.kind === "assistant") {
                const imageSrc = resolveAgentAvatarImageSrc({ handle: option.token });
                return (
                  imageSrc ? (
                    <img
                      src={imageSrc}
                      alt=""
                      className="h-full w-full object-cover"
                      decoding="async"
                      draggable={false}
                    />
                  ) : (
                    option.label.trim().slice(0, 1).toUpperCase() || "@"
                  )
                );
              }
              if (option.kind === "agent") {
                const normalizedHandle = normalizeAgentHandle(option.token);
                const profile = normalizedHandle ? agentProfilesByHandle.get(normalizedHandle) ?? null : null;
                const imageSrc = profile
                  ? resolveAgentAvatarImageSrc(profile)
                  : resolveAgentAvatarImageSrc({ handle: normalizedHandle });
                if (imageSrc) {
                  return (
                    <img
                      src={imageSrc}
                      alt=""
                      className="h-full w-full object-cover"
                      decoding="async"
                      draggable={false}
                    />
                  );
                }
                return (
                  <span
                    aria-hidden="true"
                    className="inline-flex h-full w-full items-center justify-center text-3xs font-semibold text-white"
                    style={{
                      backgroundImage: resolveAgentAvatarGradient(
                        profile?.avatarSeed?.trim() || profile?.handle?.trim() || option.token,
                      ),
                    }}
                  >
                    {resolveAgentAvatarText({
                      handle: profile?.handle ?? option.token,
                      displayName: profile?.displayName ?? option.label,
                    })}
                  </span>
                );
              }
              const userInitial = option.label.trim().slice(0, 1).toUpperCase() || "@";
              return userInitial;
            })()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="inline-flex shrink-0 items-center rounded-full border border-slate-300/80 bg-slate-200/70 px-2 py-0.5 text-[13px] font-semibold leading-none text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
                {option.token}
              </span>
              <Text
                as="span"
                variant="caption"
                tone="muted"
                className="truncate text-sm font-medium leading-5"
              >
                {option.label}
              </Text>
            </span>
          </span>
        </button>
      ))}
    </div>,
    anchorElement
  );
}

export function AssistantMentionsPlugin({ agentHandles, agentProfiles, mentionableUsers }: AssistantMentionsPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const suppressedSuffixRef = useRef<string | null>(null);
  const triggerMatch = useBasicTypeaheadTriggerMatch("@", {
    minLength: 0,
    maxLength: 20
  });
  const wrappedTriggerMatch = useCallback(
    (text: string, editor: Parameters<typeof triggerMatch>[1]) => {
      const suppressedSuffix = suppressedSuffixRef.current;
      if (suppressedSuffix) {
        if (text.endsWith(suppressedSuffix)) {
          return null;
        }
        suppressedSuffixRef.current = null;
      }
      return triggerMatch(text, editor);
    },
    [triggerMatch],
  );

  const mentionMatcher = useCallback((text: string): EntityMatch | null => {
    const match = MENTION_MATCH_REGEX.exec(text);
    if (!match || match.index === undefined) {
      return null;
    }
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    return { start, end };
  }, []);

  const createMentionNode = useCallback((textNode: TextNode) => {
    const token = resolveAssistantMentionToken(textNode.getTextContent());
    return $createAssistantMentionNode(token);
  }, []);

  useLexicalTextEntity(mentionMatcher, AssistantMentionNode, createMentionNode);

  const normalizedAgentHandles = useMemo(() => normalizeAgentHandles(agentHandles), [agentHandles]);
  const normalizedAgentHandleSet = useMemo(() => new Set(normalizedAgentHandles), [normalizedAgentHandles]);

  const agentProfilesByHandle = useMemo(() => {
    const lookup = new Map<string, MentionAgentProfile>();
    for (const profile of agentProfiles ?? []) {
      const normalized = normalizeAgentHandle(profile.handle);
      if (!normalized) {
        continue;
      }
      lookup.set(normalized, profile);
    }
    return lookup;
  }, [agentProfiles]);

  const baseOptions = useMemo(() => {
    return buildAssistantMentionOptionConfigs({
      agentHandles: normalizedAgentHandles,
      agentProfiles: Array.from(agentProfilesByHandle.values()),
      mentionableUsers,
    }).map((option) => new AssistantMentionOption(option));
  }, [mentionableUsers, agentProfilesByHandle, normalizedAgentHandles]);

  const agentMentionMatcher = useCallback(
    (text: string): EntityMatch | null => {
      const match = AGENT_MENTION_MATCH_REGEX.exec(text);
      if (!match || match.index === undefined) {
        return null;
      }
      const start = match.index + match[1].length;
      const token = (match[2] ?? "").toLowerCase();
      const handle = normalizeAgentHandle(token);
      if (!handle || resolveBuiltInAssistantHandle(handle) || !normalizedAgentHandleSet.has(handle)) {
        return null;
      }
      const end = start + token.length;
      return { start, end };
    },
    [normalizedAgentHandleSet],
  );

  const createAgentMentionNode = useCallback(
    (textNode: TextNode) => {
      const token = textNode.getTextContent();
      const handle = normalizeAgentHandle(token);
      if (!handle || !normalizedAgentHandleSet.has(handle)) {
        return $createTextNode(token);
      }
      const profile = agentProfilesByHandle.get(handle);
      const displayName = profile?.displayName?.trim() || formatAgentDisplayName(handle);
      return $createAgentMentionNode({ handle, displayName });
    },
    [agentProfilesByHandle, normalizedAgentHandleSet],
  );

  useLexicalTextEntity(agentMentionMatcher, AgentMentionNode, createAgentMentionNode);
  const options = useMemo(() => {
    if (!query) {
      return baseOptions;
    }
    const lower = query.toLowerCase();
    return baseOptions.filter((option) =>
      option.token.includes(lower) ||
      option.label.toLowerCase().includes(lower) ||
      option.description.toLowerCase().includes(lower)
    );
  }, [baseOptions, query]);

  const onSelectOption = useCallback(
    (option: AssistantMentionOption, textNodeContainingQuery: TextNode | null, closeMenu: () => void) => {
      suppressedSuffixRef.current = `${option.token} `;
      setQuery(null);
      editor.update(() => {
        const insertedNode = (() => {
          if (option.kind === "assistant") {
            return $createAssistantMentionNode(option.token as AssistantMentionToken);
          }
          if (option.kind === "agent") {
            const handle = normalizeAgentHandle(option.token);
            if (!handle) {
              return $createTextNode(option.token);
            }
            return $createAgentMentionNode({ handle, displayName: option.label });
          }
          if (option.kind === "user") {
            const userId = option.userId ?? "";
            const handle = option.handle ?? "";
            const displayName = option.displayName ?? option.label;
            if (!userId || !handle) {
              return $createTextNode(option.token);
            }
            return $createUserMentionNode({ userId, handle, displayName });
          }
          return $createTextNode(option.token);
        })();
        if (textNodeContainingQuery) {
          textNodeContainingQuery.replace(insertedNode);
        } else {
          $insertNodes([insertedNode]);
        }
        const nextSibling = insertedNode.getNextSibling();
        if (!$isTextNode(nextSibling) || !nextSibling.getTextContent().startsWith(" ")) {
          const spacer = $createTextNode(" ");
          insertedNode.insertAfter(spacer);
          spacer.select();
        } else {
          nextSibling.selectStart();
        }
      });
      closeMenu();
    },
    [editor]
  );

  return (
    <LexicalTypeaheadMenuPlugin
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={wrappedTriggerMatch}
      options={options}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options }) => {
        if (!anchorElementRef.current || options.length === 0) {
          return null;
        }
        return (
          <AssistantMentionsMenu
            anchorElement={anchorElementRef.current}
            options={options}
            selectedIndex={selectedIndex}
            selectOptionAndCleanUp={selectOptionAndCleanUp}
            setHighlightedIndex={setHighlightedIndex}
            agentProfilesByHandle={agentProfilesByHandle}
          />
        );
      }}
      ignoreEntityBoundary
    />
  );
}
