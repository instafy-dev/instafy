import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AiFace } from "../../../../components/AiFace";
import { AiTag } from "../../../../components/AiTag";
import { HumanAvatar } from "../../../../components/HumanAvatar";
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalTextEntity } from "@lexical/react/useLexicalTextEntity";
import type { EntityMatch } from "@lexical/text";
import { $createTextNode, $insertNodes, $isTextNode, type TextNode } from "lexical";
import type { AssistantMentionToken } from "../../../../conversations/assistantMentions";
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
import { ComposerSuggestionMenu, ComposerSuggestionOption } from "./ComposerSuggestions";

export type MentionAgentProfile = {
  id?: string | null;
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

// A person's 24px face shell clips the face to its circle and carries the
// shared avatar coin shadow in light, with a hairline border and small shadow
// in dark (docs/Brand.md, "One rule for faces"). An AI's face is the tile
// itself (AiFace), whose inside hairline is its only edge in dark.
const MENTION_PERSON_FACE_SHELL_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white text-3xs font-semibold text-slate-700 shadow-avatar-coin dark:border dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:shadow-sm";

/**
 * An option's 24px face: a person's circle, or the AI's face (AiFace, docs/Brand.md
 * "Octo's hatchlings"): Octo's tile, the viewer's saved agent as its profile
 * has it. Any other AI listed (a handle the conversation names that the viewer
 * has no saved agent for) is known here only by its handle, so it wears the
 * hollow face, as the header roster draws it; its numbered face belongs to the
 * rows it writes.
 */
export function MentionOptionFace({
  option,
  agentProfilesByHandle,
}: {
  option: Pick<AssistantMentionOption, "kind" | "token" | "label" | "userId" | "displayName">;
  agentProfilesByHandle: Map<string, MentionAgentProfile>;
}) {
  if (option.kind === "user") {
    return (
      <span className={MENTION_PERSON_FACE_SHELL_CLASS}>
        <HumanAvatar userId={option.userId} displayName={option.displayName} className="h-full w-full text-3xs" />
      </span>
    );
  }
  const normalizedHandle = option.kind === "agent" ? normalizeAgentHandle(option.token) : null;
  const profile = normalizedHandle ? agentProfilesByHandle.get(normalizedHandle) ?? null : null;
  const identity = profile
    ? {
        handle: profile.handle,
        avatarSeed: profile.avatarSeed,
        avatarUrl: profile.avatarUrl,
        agentId: profile.id,
        displayName: profile.displayName,
      }
    : { handle: option.token, textOnly: true };
  return <AiFace identity={identity} className="h-6 w-6" />;
}

/**
 * An option's second line, under its @token: the name. The picker mixes people
 * and AI, so an AI's name carries the AI tag (docs/Brand.md, "One rule for
 * faces"), and the row reads "@pia Pia, AI" to a screen reader.
 */
export function MentionOptionDescription({ option }: { option: Pick<AssistantMentionOption, "kind" | "label"> }) {
  if (option.kind === "user") {
    return <>{option.label}</>;
  }
  return (
    <>
      {option.label}
      <AiTag className="ml-1.5 inline-block align-middle" />
    </>
  );
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
    <ComposerSuggestionMenu
      style={menuStyle}
      data-testid="assistant-mention-menu"
    >
      {options.map((option, index) => (
        <ComposerSuggestionOption
          key={option.key}
          ref={option.setRefElement}
          data-testid="assistant-mention-option"
          data-token={option.token}
          isHighlighted={selectedIndex === index}
          label={option.token}
          description={<MentionOptionDescription option={option} />}
          start={<MentionOptionFace option={option} agentProfilesByHandle={agentProfilesByHandle} />}
          onClick={() => selectOptionAndCleanUp(option)}
          onMouseEnter={() => setHighlightedIndex(index)}
        />
      ))}
    </ComposerSuggestionMenu>,
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
