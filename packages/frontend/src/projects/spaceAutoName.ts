import {
  describeSkillImport,
  getOpeningUserMessage,
  isDefaultConversationTitle,
  isTrailingSmallWord,
} from "../conversations/conversationAutoTitle";
import { CONTROLLER_CONVERSATION_LIST_LIMIT } from "../conversations/conversationRemoteHistory";
import type { ConversationState } from "../conversations/conversationState";
import { buildSkillImportMessage } from "../conversations/skillCommands";
import { PRODUCT_CONNECTORS, type SkillConnector } from "../screens/studio/components/connectors";

// A space is named only after the tool or pack a `/skills import` set up.
// Everyone with access sees a space's name, and words from someone's own
// message can carry what they would not share that widely.

// The controller caps a rename at 120 characters and a new space's name not
// at all, so the names this client picks are kept shorter here.
const SPACE_NAME_MAX_CHARS = 60;

const FIRST_PARTY_SKILL_CONNECTORS = PRODUCT_CONNECTORS.filter(
  (connector): connector is SkillConnector => connector.kind === "skill",
);

// The first-party connectors, by the name their import titles a chat with
// ("Connect FreeFinance").
const FIRST_PARTY_CONNECTOR_NAMES = new Set(FIRST_PARTY_SKILL_CONNECTORS.map((connector) => connector.name));

// The first-party packs that hold those connectors, by the label an import of
// the whole pack titles a chat with ("Set up Bookkeeping", "Set up Team").
const FIRST_PARTY_PACK_LABELS = new Set(
  FIRST_PARTY_SKILL_CONNECTORS.flatMap((connector) => {
    const packSource = connector.source.replace(/\/\.agents\/skills\/[^/]+\/?$/, "");
    const label = packSource === connector.source
      ? null
      : describeSkillImport(buildSkillImportMessage({ source: packSource }))?.label;
    return label ? [label] : [];
  }),
);

// Cut at a word, without a small word left at the end; a first word that is
// too long on its own gives no name rather than part of one.
function capSpaceName(name: string): string | null {
  const words: string[] = [];
  for (const word of name.trim().split(/\s+/)) {
    if ([...words, word].join(" ").length > SPACE_NAME_MAX_CHARS) {
      while (words.length > 1 && isTrailingSmallWord(words[words.length - 1])) {
        words.pop();
      }
      break;
    }
    words.push(word);
  }
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * A name for a space made to hold one message: the tool or pack a
 * `/skills import` line sets up ("FreeFinance", "Bookkeeping"), at most 60
 * characters, else none.
 */
export function deriveSpaceNameFromMessage(message: string): string | null {
  const label = describeSkillImport(message)?.label;
  return label ? capSpaceName(label) : null;
}

// A chat loaded from the controller holds none of its messages locally, so
// only its title is left to go on. A title is free text, though: a fallback or
// model title can read "Set up Google Ads" from a person's own message. So a
// title names the space only when it names a first-party connector ("Connect
// FreeFinance") or a first-party pack ("Set up Bookkeeping") from the reviewed
// list in connectors.ts.
function importLabelFromTitle(title: string): string | null {
  const trimmed = title.trim();
  const connector = /^Connect (.+)$/.exec(trimmed)?.[1];
  if (connector) {
    return FIRST_PARTY_CONNECTOR_NAMES.has(connector) ? connector : null;
  }
  const pack = /^Set up (.+)$/.exec(trimmed)?.[1];
  return pack && FIRST_PARTY_PACK_LABELS.has(pack) ? pack : null;
}

function isSharedRootChat(conversation: ConversationState): boolean {
  return !conversation.parentConversationId &&
    !conversation.threadKind &&
    conversation.visibility === "public" &&
    conversation.lifecycleStatus === "active";
}

// A chat nobody has written in yet (a fresh "Conversation 2") is not the
// space's first conversation, so it must not hold the name back.
function hasStarted(conversation: ConversationState): boolean {
  return conversation.hasRemoteMessages === true ||
    conversation.messages.some((message) => message.role === "user");
}

/**
 * The name an untitled space takes from its first shared root chat, or null:
 * the tool or pack that chat's opening import set up, at most 60 characters.
 * It is read from the import line when this tab holds it. Otherwise only a
 * title naming a first-party connector or pack counts ("Connect FreeFinance",
 * "Set up Bookkeeping"), since any other title may be someone's own words.
 * Later chats never stand in for the first one, so the name does not depend
 * on which chat someone opens first. Private chats never name a space,
 * because everyone with access sees the space's name.
 */
export function resolveSpaceAutoName(conversations: readonly ConversationState[]): string | null {
  // The list loads the most recently active chats only; once it is full, the
  // first one may not be among them.
  const loadedFromController = conversations.filter((conversation) => conversation.controllerId).length;
  if (loadedFromController >= CONTROLLER_CONVERSATION_LIST_LIMIT) {
    return null;
  }
  let first: ConversationState | null = null;
  for (const conversation of conversations) {
    if (isSharedRootChat(conversation) && hasStarted(conversation) &&
      (!first || conversation.createdAt < first.createdAt)) {
      first = conversation;
    }
  }
  if (!first || first.remoteSummaryPending || isDefaultConversationTitle(first.title) || first.title.trim().length === 0) {
    return null;
  }
  const openingMessage = getOpeningUserMessage(first);
  return openingMessage ? deriveSpaceNameFromMessage(openingMessage.content) : importLabelFromTitle(first.title);
}
